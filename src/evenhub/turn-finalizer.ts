import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  getEvenTurnById,
  getEvenTurnByIdempotencyKey,
  insertEvenTurn,
  transitionEvenTurnState,
} from '../db.js';
import { logger as defaultLogger } from '../logger.js';
import type { EvenDevice, EvenTurn } from './types.js';
import { createUuidV7, isUuidV4 } from './uuid.js';
import { normalizeTranscript } from './stt-client.js';
import { validateEvenHubPcm } from './wav.js';

export interface ValidatedTurnAudio {
  sha256: string;
  size: number;
  tempPath: string;
  durationMs: number;
}

export interface AcceptedTurn {
  turn: EvenTurn;
  created: boolean;
}

export class TurnFinalizationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TurnFinalizationError';
  }
}

interface FinalizerLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export interface TurnFinalizerOptions {
  audioDir: string;
  maxAudioBytes?: number;
  capture?: {
    captureValidatedPcm(
      source: string,
      durationMs: number,
      expectedSha256?: string,
    ): void;
  };
  logger?: FinalizerLogger;
  onDispatchReady?: () => void;
}

/** Shared exactly-once persistence used by streaming and POST fallback. */
export class EvenTurnFinalizer {
  private readonly maxAudioBytes: number;
  private readonly logger: FinalizerLogger;

  constructor(private readonly options: TurnFinalizerOptions) {
    this.maxAudioBytes = options.maxAudioBytes ?? 960_000;
    this.logger = options.logger ?? defaultLogger;
  }

  accept(
    device: EvenDevice,
    idempotencyKey: string,
    audio: ValidatedTurnAudio,
  ): AcceptedTurn {
    if (!isUuidV4(idempotencyKey)) {
      this.removePart(audio.tempPath);
      throw new TurnFinalizationError(
        400,
        'invalid_idempotency_key',
        'Idempotency-Key must be a UUIDv4',
      );
    }
    try {
      const pcm = fs.readFileSync(audio.tempPath);
      validateEvenHubPcm(pcm, audio.durationMs, this.maxAudioBytes);
      if (pcm.byteLength !== audio.size) throw new Error('size mismatch');
      if (createHash('sha256').update(pcm).digest('hex') !== audio.sha256) {
        throw new Error('checksum mismatch');
      }
    } catch {
      this.removePart(audio.tempPath);
      throw new TurnFinalizationError(
        422,
        'invalid_audio',
        'PCM byte count does not match the declared duration',
      );
    }

    const existing = getEvenTurnByIdempotencyKey(device.id, idempotencyKey);
    if (existing) return this.replay(existing, audio);

    fs.mkdirSync(this.options.audioDir, { recursive: true, mode: 0o700 });
    const id = createUuidV7();
    const finalPath = path.join(this.options.audioDir, `${id}.pcm`);
    const timestamp = new Date().toISOString();
    fs.renameSync(audio.tempPath, finalPath);
    const turn: EvenTurn = {
      id,
      device_id: device.id,
      idempotency_key: idempotencyKey,
      request_sha256: audio.sha256,
      audio_path: finalPath,
      audio_duration_ms: audio.durationMs,
      state: 'accepted',
      transcript: null,
      whatsapp_message_id: null,
      answer: null,
      error_code: null,
      error_message: null,
      stt_attempts: 0,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
    };
    try {
      insertEvenTurn(turn);
    } catch (error) {
      fs.rmSync(finalPath, { force: true });
      const raced = getEvenTurnByIdempotencyKey(device.id, idempotencyKey);
      if (!raced) throw error;
      return this.replay(raced, { ...audio, tempPath: finalPath });
    }
    this.logger.info(
      {
        turn_id: id,
        state: 'accepted',
        audio_duration_ms: audio.durationMs,
        audio_bytes: audio.size,
      },
      'even.turn.accepted',
    );
    return { turn, created: true };
  }

  finalizeStreaming(
    device: EvenDevice,
    idempotencyKey: string,
    audio: ValidatedTurnAudio,
    rawTranscript: string,
  ): AcceptedTurn {
    const transcript = normalizeTranscript(rawTranscript);
    if (!transcript) {
      this.removePart(audio.tempPath);
      throw new TurnFinalizationError(
        422,
        'stt_unintelligible',
        'No speech was recognized',
      );
    }
    const accepted = this.accept(device, idempotencyKey, audio);
    if (!accepted.created) return accepted;
    const { turn } = accepted;
    if (!transitionEvenTurnState(turn.id, 'accepted', 'transcribing')) {
      throw new Error('new streaming turn could not enter transcribing');
    }
    try {
      this.options.capture?.captureValidatedPcm(
        turn.audio_path,
        turn.audio_duration_ms,
        turn.request_sha256,
      );
    } catch {
      this.logger.warn({ turn_id: turn.id }, 'even.capture_hook_failed');
    }
    if (
      !transitionEvenTurnState(turn.id, 'transcribing', 'dispatching', {
        transcript,
      })
    ) {
      throw new Error('new streaming turn could not enter dispatching');
    }
    try {
      fs.rmSync(turn.audio_path, { force: true });
    } catch {
      this.logger.warn(
        { turn_id: turn.id, state: 'audio_cleanup_pending' },
        'even.audio_cleanup_failed',
      );
    }
    this.logger.info(
      {
        turn_id: turn.id,
        state: 'dispatching',
        audio_duration_ms: turn.audio_duration_ms,
      },
      'stt.completed',
    );
    this.options.onDispatchReady?.();
    return { turn: getEvenTurnById(turn.id)!, created: true };
  }

  private replay(existing: EvenTurn, audio: ValidatedTurnAudio): AcceptedTurn {
    this.removePart(audio.tempPath);
    if (existing.request_sha256 !== audio.sha256) {
      this.logger.warn(
        { turn_id: existing.id, state: existing.state },
        'even.idempotency_mismatch',
      );
      throw new TurnFinalizationError(
        409,
        'idempotency_payload_mismatch',
        'Idempotency-Key was already used with different audio',
      );
    }
    return { turn: existing, created: false };
  }

  private removePart(file: string): void {
    fs.rmSync(file, { force: true });
  }
}
