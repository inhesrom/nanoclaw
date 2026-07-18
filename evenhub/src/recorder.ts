import type { AudioInputSource } from '@evenrealities/even_hub_sdk';

import type { TurnController } from './controller';

interface AudioBridgePort {
  audioControl(open: boolean, source?: AudioInputSource): Promise<boolean>;
}

interface G2RecorderOptions {
  bridge: AudioBridgePort;
  controller: Pick<
    TurnController,
    | 'state'
    | 'startRecording'
    | 'recordingProgress'
    | 'recordingStopped'
    | 'recordingFailed'
    | 'streamPcm'
    | 'submit'
  >;
  audioSource: AudioInputSource;
  maxAudioBytes?: number;
  maxDurationMs?: number;
  scheduleStop?: (callback: () => void, milliseconds: number) => number;
  cancelStop?: (timer: number) => void;
  onCloseError?: (error: unknown) => void;
}

const DEFAULT_MAX_AUDIO_BYTES = 960_000;
const DEFAULT_MAX_DURATION_MS = 30_000;

export class G2Recorder {
  private readonly maxAudioBytes: number;
  private readonly maxDurationMs: number;
  private readonly scheduleStop: (
    callback: () => void,
    milliseconds: number,
  ) => number;
  private readonly cancelStop: (timer: number) => void;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private reportedTenth = -1;
  private stopTimer: number | undefined;
  private stopping = false;

  constructor(private readonly options: G2RecorderOptions) {
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.scheduleStop =
      options.scheduleStop ??
      ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
    this.cancelStop =
      options.cancelStop ?? ((timer) => window.clearTimeout(timer));
  }

  async start(): Promise<void> {
    if (this.options.controller.state.kind !== 'ready') return;
    this.chunks = [];
    this.bytes = 0;
    this.reportedTenth = -1;
    this.stopping = false;
    this.options.controller.startRecording();
    try {
      const opened = await this.options.bridge.audioControl(
        true,
        this.options.audioSource,
      );
      if (opened) {
        this.stopTimer = this.scheduleStop(
          () => void this.finish(),
          this.maxDurationMs,
        );
        return;
      }
      this.options.controller.recordingFailed(
        'The G2 microphone could not be opened.',
      );
    } catch (error) {
      this.options.controller.recordingFailed(
        error instanceof Error ? error.message : 'The G2 microphone failed.',
      );
    }
  }

  pushPcm(pcm: Uint8Array): void {
    if (this.stopping || this.options.controller.state.kind !== 'recording') {
      return;
    }
    const remaining = this.maxAudioBytes - this.bytes;
    if (remaining <= 0) return;
    const chunk = new Uint8Array(pcm.slice(0, remaining));
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.options.controller.streamPcm(chunk);
    const tenth = Math.floor(this.bytes / 3_200);
    if (tenth !== this.reportedTenth) {
      this.reportedTenth = tenth;
      this.options.controller.recordingProgress(this.bytes);
    }
    if (this.bytes >= this.maxAudioBytes) void this.finish();
  }

  async finish(): Promise<void> {
    if (this.options.controller.state.kind !== 'recording' || this.stopping) {
      return;
    }
    this.stopping = true;
    this.clearStopTimer();

    const durationMs = Math.round(this.bytes / 32);
    const pcm = joinChunks(this.chunks, this.bytes);
    this.chunks = [];
    this.bytes = 0;
    this.reportedTenth = -1;

    this.options.controller.recordingStopped();
    const finalizing =
      durationMs >= 250
        ? Promise.resolve().then(() =>
            this.options.controller.submit(pcm, durationMs),
          )
        : undefined;
    await this.closeMicrophone();

    try {
      if (durationMs < 250) {
        this.options.controller.recordingFailed(
          'Keep recording for at least a quarter second.',
        );
        return;
      }
      await finalizing;
    } finally {
      this.stopping = false;
    }
  }

  async cancel(): Promise<void> {
    this.stopping = true;
    this.clearStopTimer();
    this.chunks = [];
    this.bytes = 0;
    this.reportedTenth = -1;
    await this.closeMicrophone();
    this.stopping = false;
  }

  private clearStopTimer(): void {
    if (this.stopTimer === undefined) return;
    this.cancelStop(this.stopTimer);
    this.stopTimer = undefined;
  }

  private async closeMicrophone(): Promise<void> {
    try {
      await this.options.bridge.audioControl(false);
    } catch (error) {
      this.options.onCloseError?.(error);
    }
  }
}

function joinChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const pcm = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  return pcm;
}
