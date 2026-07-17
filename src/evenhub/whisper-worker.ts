import { createHash } from 'crypto';
import fs from 'fs';

import {
  claimNextAcceptedEvenTurn,
  incrementEvenTurnSttAttempts,
  reconcileEvenSttTurns,
  transitionEvenTurnState,
} from '../db.js';
import { logger as defaultLogger } from '../logger.js';
import type { EvenTurn } from './types.js';
import type { EvenTurnProcessor } from './server.js';
import { validateEvenHubPcm } from './wav.js';
import {
  SttClientError,
  normalizeTranscript,
  type SttTranscriber,
} from './stt-client.js';

interface WorkerLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

export interface EvenHubSttWorkerOptions {
  capture?: {
    captureValidatedPcm(
      source: string,
      durationMs: number,
      expectedSha256?: string,
    ): void;
  };
  delay?: (milliseconds: number) => Promise<void>;
  logger?: WorkerLogger;
  maxAudioBytes?: number;
  onDispatchReady?: () => void;
}

const defaultDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class EvenHubSttWorker implements EvenTurnProcessor {
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly capture?: EvenHubSttWorkerOptions['capture'];
  private readonly logger: WorkerLogger;
  private readonly maxAudioBytes: number;
  private readonly onDispatchReady?: () => void;
  private running = false;
  private workRequested = false;
  private stopping = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly transcriber: SttTranscriber,
    options: EvenHubSttWorkerOptions = {},
  ) {
    this.delay = options.delay ?? defaultDelay;
    this.capture = options.capture;
    this.logger = options.logger ?? defaultLogger;
    this.maxAudioBytes = options.maxAudioBytes ?? 960_000;
    this.onDispatchReady = options.onDispatchReady;
  }

  start(): void {
    const reconciled = reconcileEvenSttTurns();
    if (reconciled > 0) {
      this.logger.info({ recovered_turns: reconciled }, 'stt.reconciled');
    }
    this.requestDrain();
  }

  async process(_turn: EvenTurn): Promise<void> {
    this.requestDrain();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.waitForIdle();
  }

  waitForIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private requestDrain(): void {
    if (this.stopping) return;
    this.workRequested = true;
    if (this.running) return;
    this.running = true;
    void this.drain().catch((error) => {
      this.logger.error({ error_type: errorName(error) }, 'stt.worker_failed');
    });
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopping) {
        this.workRequested = false;
        let turn: EvenTurn | undefined;
        while (!this.stopping && (turn = claimNextAcceptedEvenTurn())) {
          await this.transcribeTurn(turn);
        }
        if (!this.workRequested) break;
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private async transcribeTurn(turn: EvenTurn): Promise<void> {
    const startedAt = Date.now();
    let pcm: Buffer;
    try {
      pcm = fs.readFileSync(turn.audio_path);
      validateEvenHubPcm(pcm, turn.audio_duration_ms, this.maxAudioBytes);
      const digest = createHash('sha256').update(pcm).digest('hex');
      if (digest !== turn.request_sha256) throw new Error('checksum mismatch');
    } catch {
      this.failTurn(
        turn,
        'invalid_audio',
        'The recording is invalid; record a new turn.',
        startedAt,
      );
      return;
    }
    try {
      this.capture?.captureValidatedPcm(
        turn.audio_path,
        turn.audio_duration_ms,
        turn.request_sha256,
      );
    } catch (_error) {
      this.logger.warn({ turn_id: turn.id }, 'even.capture_hook_failed');
    }

    let attempts = turn.stt_attempts;
    while (attempts < 2) {
      attempts = incrementEvenTurnSttAttempts(turn.id);
      if (attempts === 0) return;
      const inferenceStartedAt = Date.now();
      this.logger.info(
        {
          turn_id: turn.id,
          state: 'transcribing',
          attempt: attempts,
          audio_duration_ms: turn.audio_duration_ms,
          audio_bytes: pcm.byteLength,
        },
        'stt.started',
      );
      try {
        const transcript = normalizeTranscript(
          await this.transcriber.transcribe(pcm),
        );
        if (!transcript) {
          this.failTurn(
            turn,
            'stt_unintelligible',
            'No speech was recognized; record a new turn.',
            startedAt,
            attempts,
          );
          return;
        }

        const persisted = transitionEvenTurnState(
          turn.id,
          'transcribing',
          'dispatching',
          { transcript },
        );
        if (!persisted) return;
        this.deletePcm(turn.id, turn.audio_path);
        this.logger.info(
          {
            turn_id: turn.id,
            state: 'dispatching',
            attempt: attempts,
            inference_ms: Date.now() - inferenceStartedAt,
            elapsed_ms: Date.now() - startedAt,
          },
          'stt.completed',
        );
        this.onDispatchReady?.();
        return;
      } catch (error) {
        const retryable = !(error instanceof SttClientError) || error.retryable;
        if (retryable && attempts < 2) {
          await this.delay(1_000);
          continue;
        }
        this.failTurn(
          turn,
          retryable ? 'stt_unavailable' : 'invalid_audio',
          retryable
            ? 'Local speech recognition is unavailable; try a new turn.'
            : 'The recording was rejected; record a new turn.',
          startedAt,
          attempts,
        );
        return;
      }
    }

    this.failTurn(
      turn,
      'stt_unavailable',
      'Local speech recognition is unavailable; try a new turn.',
      startedAt,
      attempts,
    );
  }

  private failTurn(
    turn: EvenTurn,
    code: 'invalid_audio' | 'stt_unavailable' | 'stt_unintelligible',
    message: string,
    startedAt: number,
    attempt = turn.stt_attempts,
  ): void {
    const completedAt = new Date().toISOString();
    const persisted = transitionEvenTurnState(
      turn.id,
      'transcribing',
      'failed',
      {
        errorCode: code,
        errorMessage: message,
        completedAt,
      },
    );
    if (!persisted) return;
    this.deletePcm(turn.id, turn.audio_path);
    this.logger.info(
      {
        turn_id: turn.id,
        state: 'failed',
        attempt,
        error_code: code,
        elapsed_ms: Date.now() - startedAt,
      },
      'even.turn.failed',
    );
  }

  private deletePcm(turnId: string, audioPath: string): void {
    try {
      fs.rmSync(audioPath, { force: true });
    } catch {
      this.logger.warn(
        { turn_id: turnId, state: 'audio_cleanup_pending' },
        'even.audio_cleanup_failed',
      );
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
