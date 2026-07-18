import {
  AudioInputSource,
  CreateStartUpPageContainer,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

import { EvenHubApi } from './api';
import { TurnController } from './controller';
import { routeHubInteraction } from './event-routing';
import { createG2StartupContainers, glassesView } from './g2-display';
import { CoalescingGlassesRenderer } from './glasses-renderer';
import { handlePrimaryTap } from './primary-tap';
import { G2Recorder } from './recorder';
import type { AppState } from './state';
import { BridgeStorage } from './storage';
import { ThinkingStatusAnimation } from './thinking-status';
import { mountCompanionUi } from './ui';

const origin = import.meta.env.VITE_EVENHUB_ORIGIN;
if (!origin) throw new Error('VITE_EVENHUB_ORIGIN is required');

interface HubEvent {
  audioEvent?: { audioPcm?: Uint8Array };
  sysEvent?: { eventType?: number };
  textEvent?: { eventType?: number };
}

const bridge = await waitForEvenAppBridge();
const startupContainers = createG2StartupContainers({
  feed: 'NanoClaw\nConnecting…',
  scrollbar: '',
  status: 'Private Tailscale link',
});
await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: startupContainers.length,
    textObject: startupContainers,
  }),
);

const controllerRef: { current?: TurnController } = {};
const recorderRef: { current?: G2Recorder } = {};
const companion = mountCompanionUi({
  onPair: (code) => controllerRef.current!.pair(code),
  onRetry: () => controllerRef.current!.retry(),
  onNewTurn: () => controllerRef.current!.newTurn(),
  onSendText: (text) => controllerRef.current!.submitText(text),
  onConfirm: async (decision) => {
    const resolved = await controllerRef.current!.confirm(decision);
    if (resolved === 'discard') await recorderRef.current?.start();
  },
});
const glasses = new CoalescingGlassesRenderer({
  bridge,
  onError: (error) => console.error('Glasses render failed:', error),
});
const thinkingStatus = new ThinkingStatusAnimation((status) => {
  const state = controllerRef.current?.state;
  if (state?.kind === 'thinking') {
    glasses.render(glassesView(state, status));
  }
});

function render(state: AppState): void {
  companion.render(state);
  thinkingStatus.sync(state.kind === 'thinking');
  glasses.render(glassesView(state, thinkingStatus.status));
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
  companion.dispose();
  thinkingStatus.dispose();
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
