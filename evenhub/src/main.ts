import {
  AudioInputSource,
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

import { EvenHubApi } from './api';
import { TurnController } from './controller';
import { paginate } from './paginate';
import type { AppState } from './state';
import { BridgeStorage } from './storage';
import { mountCompanionUi } from './ui';

const origin = import.meta.env.VITE_EVENHUB_ORIGIN || 'https://nanoclaw.local';
const MAX_AUDIO_BYTES = 960_000;
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
  content: 'Private LAN voice link',
  isEventCapture: 0,
});
await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [startupBody, startupPager],
  }),
);

let controller!: TurnController;
const companion = mountCompanionUi({
  onPair: (code) => controller.pair(code),
  onRetry: () => controller.retry(),
  onNewTurn: () => controller.newTurn(),
});
let rendering: Promise<unknown> = Promise.resolve();

function render(state: AppState): void {
  companion.render(state);
  const view = glassesView(state);
  rendering = rendering
    .then(async () => {
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 1,
          containerName: 'body',
          content: view.body,
        }),
      );
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 2,
          containerName: 'pager',
          content: view.pager,
        }),
      );
    })
    .catch((error) => console.error('Glasses render failed:', error));
}

controller = new TurnController({
  api: new EvenHubApi(origin),
  storage: new BridgeStorage(bridge),
  paginateAnswer: (answer) =>
    paginate(answer, { width: INNER_WIDTH, height: INNER_HEIGHT }),
  onState: render,
});

let audioChunks: Uint8Array[] = [];
let audioBytes = 0;
let stopTimer: number | undefined;
let stopping = false;

async function startRecording(): Promise<void> {
  if (controller.state.kind !== 'ready') return;
  audioChunks = [];
  audioBytes = 0;
  controller.startRecording();
  try {
    const opened = await bridge.audioControl(true, AudioInputSource.Glasses);
    if (opened) {
      stopTimer = window.setTimeout(() => void finishRecording(), 30_000);
      return;
    }
    controller.recordingFailed('The G2 microphone could not be opened.');
  } catch (error) {
    controller.recordingFailed(
      error instanceof Error ? error.message : 'The G2 microphone failed.',
    );
  }
}

async function finishRecording(): Promise<void> {
  if (controller.state.kind !== 'recording' || stopping) return;
  stopping = true;
  if (stopTimer !== undefined) window.clearTimeout(stopTimer);
  stopTimer = undefined;
  try {
    await bridge.audioControl(false);
  } catch (error) {
    console.error('Could not close the G2 microphone:', error);
  }
  const durationMs = Math.round(audioBytes / 32);
  if (durationMs < 250) {
    controller.recordingFailed('Keep recording for at least a quarter second.');
    audioChunks = [];
    stopping = false;
    return;
  }
  const pcm = new Uint8Array(audioBytes);
  let offset = 0;
  for (const chunk of audioChunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  audioChunks = [];
  stopping = false;
  await controller.submit(pcm, durationMs);
}

let unsubscribe: () => void = () => undefined;
let cleanedUp = false;
async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  if (stopTimer !== undefined) window.clearTimeout(stopTimer);
  try {
    await bridge.audioControl(false);
  } catch (error) {
    console.error('Could not close the G2 microphone:', error);
  } finally {
    unsubscribe();
    controller.dispose();
    audioChunks = [];
  }
}

unsubscribe = bridge.onEvenHubEvent((event: HubEvent) => {
  const pcm = event.audioEvent?.audioPcm;
  if (pcm && controller.state.kind === 'recording') {
    const remaining = MAX_AUDIO_BYTES - audioBytes;
    if (remaining > 0) {
      const chunk = new Uint8Array(pcm.slice(0, remaining));
      audioChunks.push(chunk);
      audioBytes += chunk.length;
      controller.recordingProgress(audioBytes);
    }
    if (audioBytes >= MAX_AUDIO_BYTES) void finishRecording();
  }

  const sysType = event.sysEvent
    ? (event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT)
    : null;
  const textType = event.textEvent
    ? (event.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT)
    : null;
  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    void bridge.shutDownPageContainer(1);
    return;
  }
  if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    controller.previousPage();
    return;
  }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    controller.nextPage();
    return;
  }
  if (sysType === OsEventTypeList.CLICK_EVENT) {
    if (controller.state.kind === 'ready') void startRecording();
    else if (controller.state.kind === 'recording') void finishRecording();
    else if (controller.state.kind === 'answer') controller.nextPage();
    return;
  }
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    if (controller.state.kind === 'recording') {
      if (stopTimer !== undefined) window.clearTimeout(stopTimer);
      stopTimer = undefined;
      void bridge.audioControl(false);
      audioChunks = [];
      audioBytes = 0;
      void controller.newTurn();
    }
    return;
  }
  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
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
      return { body: 'NanoClaw\nConnecting…', pager: 'Private LAN voice link' };
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
        body: `Recording…\n\n${(state.bytes / 32_000).toFixed(1)} seconds`,
        pager: 'Tap: send',
      };
    case 'uploading':
      return { body: 'Securing audio…', pager: 'Local network' };
    case 'transcribing':
      return {
        body: state.notice || state.transcript || 'Transcribing locally…',
        pager: 'Whisper on NanoClaw host',
      };
    case 'thinking':
      return {
        body: state.notice || state.transcript || 'NanoClaw is thinking…',
        pager: 'Shared WhatsApp context',
      };
    case 'answer':
      return {
        body: state.pages[state.page],
        pager: `${state.page + 1} / ${state.pages.length} · tap: next · swipe up: prev`,
      };
    case 'error':
      return {
        body: `Could not complete the turn\n\n${state.message}`,
        pager: state.retryable ? 'Retry in companion' : 'Return in companion',
      };
  }
}
