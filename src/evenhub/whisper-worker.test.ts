import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  activateEvenDeviceFromPairingCode,
  getEvenTurnById,
  insertEvenTurn,
  replaceEvenPairingCode,
} from '../db.js';
import type { NewEvenTurn } from '../db.js';
import { WhisperClientError } from './whisper-client.js';
import type { WhisperTranscriber } from './whisper-client.js';
import { EvenHubSttWorker } from './whisper-worker.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('EvenHubSttWorker', () => {
  let audioDir: string;
  let sequence: number;

  beforeEach(() => {
    _initTestDatabase();
    const now = '2026-07-16T00:00:00.000Z';
    const pairingHash = 'a'.repeat(64);
    replaceEvenPairingCode({
      code_sha256: pairingHash,
      created_at: now,
      expires_at: '2026-07-16T00:05:00.000Z',
      consumed_at: null,
    });
    activateEvenDeviceFromPairingCode(
      pairingHash,
      {
        id: 'device-1',
        name: 'test device',
        token_sha256: 'b'.repeat(64),
        created_at: now,
        last_used_at: now,
        revoked_at: null,
      },
      now,
    );
    audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-stt-'));
    sequence = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    _closeDatabase();
    fs.rmSync(audioDir, { recursive: true, force: true });
  });

  function acceptedTurn(
    id: string,
    pcm = syntheticPcm(250),
    overrides: Partial<NewEvenTurn> = {},
  ): string {
    const audioPath = path.join(audioDir, `${id}.pcm`);
    fs.writeFileSync(audioPath, pcm, { mode: 0o600 });
    const timestamp = new Date(
      Date.UTC(2026, 6, 16, 0, 0, sequence++),
    ).toISOString();
    insertEvenTurn({
      id,
      device_id: 'device-1',
      idempotency_key: `key-${id}`,
      request_sha256: createHash('sha256').update(pcm).digest('hex'),
      audio_path: audioPath,
      audio_duration_ms: 250,
      state: 'accepted',
      created_at: timestamp,
      updated_at: timestamp,
      ...overrides,
    });
    return audioPath;
  }

  function worker(
    transcriber: WhisperTranscriber,
    delay: (milliseconds: number) => Promise<void> = async () => undefined,
  ): EvenHubSttWorker {
    return new EvenHubSttWorker(transcriber, {
      delay,
      logger: silentLogger,
    });
  }

  it('claims accepted turns FIFO and persists transcripts before cleanup', async () => {
    const firstPath = acceptedTurn('turn-1');
    const secondPath = acceptedTurn('turn-2');
    const calls: string[] = [];
    const stt = worker({
      async transcribe() {
        const transcript = calls.length === 0 ? 'first turn' : 'second turn';
        calls.push(transcript);
        return transcript;
      },
    });

    stt.start();
    await stt.waitForIdle();

    expect(calls).toEqual(['first turn', 'second turn']);
    expect(getEvenTurnById('turn-1')).toMatchObject({
      state: 'dispatching',
      transcript: 'first turn',
      stt_attempts: 1,
    });
    expect(getEvenTurnById('turn-2')).toMatchObject({
      state: 'dispatching',
      transcript: 'second turn',
      stt_attempts: 1,
    });
    expect(fs.existsSync(firstPath)).toBe(false);
    expect(fs.existsSync(secondPath)).toBe(false);
    expect(JSON.stringify(silentLogger.info.mock.calls)).not.toContain(
      'first turn',
    );
    expect(JSON.stringify(silentLogger.info.mock.calls)).not.toContain(
      'second turn',
    );
  });

  it('reclaims an interrupted transcription on startup', async () => {
    acceptedTurn('turn-interrupted', syntheticPcm(250), {
      state: 'transcribing',
    });
    const stt = worker({
      async transcribe() {
        return 'recovered after restart';
      },
    });

    stt.start();
    await stt.waitForIdle();

    expect(getEvenTurnById('turn-interrupted')).toMatchObject({
      state: 'dispatching',
      transcript: 'recovered after restart',
      stt_attempts: 1,
    });
  });

  it('retries one transient failure after one second', async () => {
    acceptedTurn('turn-retry');
    const delays: number[] = [];
    let attempts = 0;
    const stt = worker(
      {
        async transcribe() {
          attempts += 1;
          if (attempts === 1) {
            throw new WhisperClientError(
              'stt_unavailable',
              true,
              'unavailable',
              503,
            );
          }
          return 'recovered';
        },
      },
      async (milliseconds) => {
        delays.push(milliseconds);
      },
    );

    stt.start();
    await stt.waitForIdle();

    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(getEvenTurnById('turn-retry')).toMatchObject({
      state: 'dispatching',
      transcript: 'recovered',
      stt_attempts: 2,
    });
  });

  it('maps retry exhaustion to stt_unavailable and removes PCM', async () => {
    const audioPath = acceptedTurn('turn-down');
    const stt = worker({
      async transcribe() {
        throw new WhisperClientError(
          'stt_unavailable',
          true,
          'unavailable',
          503,
        );
      },
    });

    stt.start();
    await stt.waitForIdle();

    expect(getEvenTurnById('turn-down')).toMatchObject({
      state: 'failed',
      error_code: 'stt_unavailable',
      stt_attempts: 2,
    });
    expect(fs.existsSync(audioPath)).toBe(false);
  });

  it('maps no speech to stt_unintelligible without retrying', async () => {
    const audioPath = acceptedTurn('turn-silent');
    const transcribe = vi.fn(async () => '   ');
    const stt = worker({ transcribe });

    stt.start();
    await stt.waitForIdle();

    expect(transcribe).toHaveBeenCalledOnce();
    expect(getEvenTurnById('turn-silent')).toMatchObject({
      state: 'failed',
      error_code: 'stt_unintelligible',
      stt_attempts: 1,
    });
    expect(fs.existsSync(audioPath)).toBe(false);
  });

  it('rejects malformed or corrupted PCM before calling Whisper', async () => {
    const audioPath = acceptedTurn('turn-bad', new Uint8Array(8_001), {
      audio_duration_ms: 250,
    });
    const transcribe = vi.fn(async () => 'must not run');
    const stt = worker({ transcribe });

    stt.start();
    await stt.waitForIdle();

    expect(transcribe).not.toHaveBeenCalled();
    expect(getEvenTurnById('turn-bad')).toMatchObject({
      state: 'failed',
      error_code: 'invalid_audio',
      stt_attempts: 0,
    });
    expect(fs.existsSync(audioPath)).toBe(false);
  });

  it('leaves the ordinary turn unaffected when the capture hook fails', async () => {
    acceptedTurn('turn-capture-failure');
    const stt = new EvenHubSttWorker(
      { transcribe: async () => 'ordinary transcript' },
      {
        logger: silentLogger,
        capture: {
          captureValidatedPcm() {
            throw new Error('capture disk failure');
          },
        },
      },
    );

    stt.start();
    await stt.waitForIdle();

    expect(getEvenTurnById('turn-capture-failure')).toMatchObject({
      state: 'dispatching',
      transcript: 'ordinary transcript',
    });
    expect(JSON.stringify(silentLogger.warn.mock.calls)).not.toContain(
      'capture disk failure',
    );
  });
});

function syntheticPcm(durationMs: number): Uint8Array {
  const samples = Math.round((16_000 * durationMs) / 1_000);
  const pcm = Buffer.alloc(samples * 2);
  for (let sample = 0; sample < samples; sample += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * 440 * sample) / 16_000) * 8_000,
    );
    pcm.writeInt16LE(value, sample * 2);
  }
  return pcm;
}
