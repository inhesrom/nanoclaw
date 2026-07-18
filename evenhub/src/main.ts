import {
  AudioInputSource,
  CreateStartUpPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

import { EvenHubApi } from './api';
import { conversationProjectionForState, TurnController } from './controller';
import { routeHubInteraction } from './event-routing';
import { CoalescingGlassesRenderer } from './glasses-renderer';
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
const recorderRef: { current?: G2Recorder } = {};
const companion = mountCompanionUi({
  onPair: (code) => controllerRef.current!.pair(code),
  onRetry: () => controllerRef.current!.retry(),
  onNewTurn: () => controllerRef.current!.newTurn(),
  onConfirm: async (decision) => {
    const resolved = await controllerRef.current!.confirm(decision);
    if (resolved === 'discard') await recorderRef.current?.start();
  },
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
recorderRef.current = recorder;

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
    if (controller.state.kind === 'review' && controller.state.choiceOpen) {
      controller.closeConfirmationChoice();
      return;
    }
    void bridge.shutDownPageContainer(1);
    return;
  }
  if (interaction === 'previous') {
    if (controller.state.kind === 'review' && controller.state.choiceOpen) {
      controller.toggleConfirmationChoice();
    } else {
      controller.scroll(-1);
    }
    return;
  }
  if (interaction === 'next') {
    if (controller.state.kind === 'review' && controller.state.choiceOpen) {
      controller.toggleConfirmationChoice();
    } else {
      controller.scroll(1);
    }
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
  const feed = conversationProjectionForState(state);
  const feedBody = feed.body || 'NanoClaw\n\nTap to record';
  const hint = contextualHint(feed.hasEarlier, feed.hasLater);
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
        body: feedBody,
        pager: joinStatus(hint, 'Tap: record'),
      };
    case 'recording':
      return {
        body: feed.body || 'Listening…',
        pager: joinStatus(
          hint,
          `Listening ${(state.bytes / 32_000).toFixed(1)}s · tap: stop`,
        ),
      };
    case 'stopping':
      return {
        body: feed.body || 'Transcribing…',
        pager: joinStatus(hint, 'Transcribing'),
      };
    case 'uploading':
      return {
        body: feed.body || 'Transcribing…',
        pager: joinStatus(hint, 'Transcribing'),
      };
    case 'transcribing':
      return {
        body: feed.body || 'Transcribing…',
        pager: joinStatus(hint, state.notice || 'Transcribing'),
      };
    case 'review':
      return {
        body: feedBody,
        pager: state.choiceOpen
          ? state.choice === 'send'
            ? '› Send     Try again'
            : '  Send   › Try again'
          : joinStatus(hint, state.notice || 'Tap: choose'),
      };
    case 'thinking':
      return {
        body: feed.body || 'NanoClaw is thinking…',
        pager: joinStatus(hint, state.notice || 'Thinking'),
      };
    case 'error':
      return {
        body: feed.body || 'NanoClaw',
        pager: state.retryable ? 'Retry in companion' : 'Return in companion',
      };
  }
}

function contextualHint(earlier: boolean, later: boolean): string {
  return [earlier ? 'Earlier' : '', later ? 'Later' : '']
    .filter(Boolean)
    .join(' · ');
}

function joinStatus(hint: string, status: string): string {
  return [hint, status].filter(Boolean).join(' · ');
}
