import {
  AudioInputSource,
  CreateStartUpPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

import { EvenHubApi } from './api';
import { TurnController } from './controller';
import { routeHubInteraction } from './event-routing';
import { CoalescingGlassesRenderer } from './glasses-renderer';
import { paginate } from './paginate';
import { handlePrimaryTap } from './primary-tap';
import { G2Recorder } from './recorder';
import type { AppState } from './state';
import { BridgeStorage } from './storage';
import { mountCompanionUi } from './ui';

const origin = import.meta.env.VITE_EVENHUB_ORIGIN;
if (!origin) throw new Error('VITE_EVENHUB_ORIGIN is required');
const BODY_WIDTH = 576;
const BODY_HEIGHT = 240;
const BODY_PADDING = 4;
const INNER_WIDTH = BODY_WIDTH - BODY_PADDING * 2;
const INNER_HEIGHT = BODY_HEIGHT - BODY_PADDING * 2;

interface HubEvent {
  audioEvent?: { audioPcm?: Uint8Array };
  sysEvent?: { eventType?: number };
  textEvent?: { eventType?: number };
}

const bridge = await waitForEvenAppBridge();
const startupBody = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: BODY_WIDTH,
  height: BODY_HEIGHT,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: BODY_PADDING,
  containerID: 1,
  containerName: 'body',
  content: 'NanoClaw\nConnecting…',
  isEventCapture: 1,
});
const startupPager = new TextContainerProperty({
  xPosition: 0,
  yPosition: 250,
  width: 576,
  height: 30,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 2,
  containerName: 'pager',
  content: 'Private Tailscale voice link',
  isEventCapture: 0,
});
await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [startupBody, startupPager],
  }),
);

const controllerRef: { current?: TurnController } = {};
const companion = mountCompanionUi({
  onPair: (code) => controllerRef.current!.pair(code),
  onRetry: () => controllerRef.current!.retry(),
  onNewTurn: () => controllerRef.current!.newTurn(),
});
const glasses = new CoalescingGlassesRenderer({
  bridge,
  onError: (error) => console.error('Glasses render failed:', error),
});

function render(state: AppState): void {
  companion.render(state);
  glasses.render(glassesView(state));
}

const controller = new TurnController({
  api: new EvenHubApi(origin),
  storage: new BridgeStorage(bridge),
  paginateAnswer: (answer) =>
    paginate(answer, { width: INNER_WIDTH, height: INNER_HEIGHT }),
  onState: render,
});
controllerRef.current = controller;
const recorder = new G2Recorder({
  bridge,
  controller,
  audioSource: AudioInputSource.Glasses,
  onCloseError: (error) =>
    console.error('Could not close the G2 microphone:', error),
});

let unsubscribe: () => void = () => undefined;
let cleanedUp = false;
async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  await recorder.cancel();
  unsubscribe();
  controller.dispose();
}

unsubscribe = bridge.onEvenHubEvent((event: HubEvent) => {
  const pcm = event.audioEvent?.audioPcm;
  if (pcm) recorder.pushPcm(pcm);

  const interaction = routeHubInteraction(event);
  if (interaction === 'exit') {
    void bridge.shutDownPageContainer(1);
    return;
  }
  if (interaction === 'previous') {
    controller.previousPage();
    return;
  }
  if (interaction === 'next') {
    controller.nextPage();
    return;
  }
  if (interaction === 'primary') {
    void handlePrimaryTap({ controller, recorder });
    return;
  }
  if (interaction === 'foreground-exit') {
    if (
      controller.state.kind === 'recording' ||
      controller.state.kind === 'stopping'
    ) {
      void recorder.cancel();
      void controller.newTurn();
    }
    return;
  }
  if (interaction === 'shutdown') {
    void cleanup();
  }
});

window.addEventListener('beforeunload', () => void cleanup());
void controller.boot().catch((error) => {
  controller.recordingFailed(
    error instanceof Error ? error.message : 'Could not restore plugin state.',
  );
});

function glassesView(state: AppState): { body: string; pager: string } {
  switch (state.kind) {
    case 'booting':
      return {
        body: 'NanoClaw\nConnecting…',
        pager: 'Private Tailscale voice link',
      };
    case 'pairing':
      return {
        body: `Pairing required\n\nOpen the companion screen.${state.error ? `\n\n${state.error}` : ''}`,
        pager: 'Companion setup',
      };
    case 'ready':
      return {
        body: 'NanoClaw\n\nTap to record',
        pager: 'Tap: start · double-tap: exit',
      };
    case 'recording':
      return {
        body: snapshotText(state)
          ? `Recording… ${(state.bytes / 32_000).toFixed(1)}s\n\n${snapshotText(state)}`
          : `Recording…\n\n${(state.bytes / 32_000).toFixed(1)} seconds`,
        pager: 'Tap: send',
      };
    case 'stopping':
      return {
        body: snapshotText(state)
          ? `Captured · finalizing\n\n${snapshotText(state)}`
          : 'Captured · finalizing',
        pager: 'Timer frozen',
      };
    case 'uploading':
      return {
        body: 'Audio captured\n\nSending securely…',
        pager: 'Private tailnet',
      };
    case 'transcribing':
      return {
        body: state.notice || state.transcript || 'Transcribing locally…',
        pager: 'Local STT on NanoClaw host',
      };
    case 'thinking':
      return {
        body: state.notice || state.transcript || 'NanoClaw is thinking…',
        pager: 'Shared WhatsApp context',
      };
    case 'answer': {
      const hasNext =
        state.page < state.pages.length - 1 ||
        state.session.turn < state.session.turns.length - 1;
      return {
        body: state.pages[state.page],
        pager: `Turn ${state.session.turn + 1}/${state.session.turns.length} · Page ${state.page + 1}/${state.pages.length} · ${hasNext ? 'tap: next' : 'tap: record'} · swipe up: prev`,
      };
    }
    case 'error':
      return {
        body: `Could not complete the turn\n\n${state.message}`,
        pager: state.retryable ? 'Retry in companion' : 'Return in companion',
      };
  }
}

function snapshotText(
  state: Extract<AppState, { kind: 'recording' | 'stopping' }>,
): string {
  return [state.finalText, state.interimText].filter(Boolean).join(' ').trim();
}
