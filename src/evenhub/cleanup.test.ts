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
import { cleanupEvenHubStorage } from './cleanup.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('cleanupEvenHubStorage', () => {
  let audioDir: string;

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
    audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evenhub-cleanup-'));
  });

  afterEach(() => {
    _closeDatabase();
    fs.rmSync(audioDir, { recursive: true, force: true });
  });

  function turn(
    id: string,
    state: 'accepted' | 'awaiting_confirmation' | 'completed' | 'discarded',
    timestamp: string,
  ) {
    const audioPath = path.join(audioDir, `${id}.pcm`);
    fs.writeFileSync(audioPath, id);
    insertEvenTurn({
      id,
      device_id: 'device-1',
      idempotency_key: `key-${id}`,
      request_sha256: createHash('sha256').update(id).digest('hex'),
      audio_path: audioPath,
      audio_duration_ms: 250,
      state,
      created_at: timestamp,
      updated_at: timestamp,
    });
    return audioPath;
  }

  it('removes seven-day terminal rows and only unreferenced old audio', () => {
    const now = new Date('2026-07-16T12:00:00.000Z');
    const expiredPath = turn(
      'expired',
      'completed',
      '2026-07-08T00:00:00.000Z',
    );
    const activePath = turn('active', 'accepted', '2026-07-08T00:00:00.000Z');
    const orphanPath = path.join(audioDir, 'orphan.pcm');
    const freshPath = path.join(audioDir, '.upload.part');
    fs.writeFileSync(orphanPath, 'orphan');
    fs.writeFileSync(freshPath, 'fresh');
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    fs.utimesSync(orphanPath, old, old);
    fs.utimesSync(activePath, old, old);

    const result = cleanupEvenHubStorage(audioDir, 7 * DAY_MS, {
      now,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ expiredTurns: 1, orphanFiles: 1 });
    expect(getEvenTurnById('expired')).toBeUndefined();
    expect(fs.existsSync(expiredPath)).toBe(false);
    expect(getEvenTurnById('active')?.state).toBe('accepted');
    expect(fs.existsSync(activePath)).toBe(true);
    expect(fs.existsSync(orphanPath)).toBe(false);
    expect(fs.existsSync(freshPath)).toBe(true);
  });

  it('retains unresolved drafts for seven days and then expires them', () => {
    const now = new Date('2026-07-16T12:00:00.000Z');
    turn('old-draft', 'awaiting_confirmation', '2026-07-08T00:00:00.000Z');
    turn('recent-draft', 'awaiting_confirmation', '2026-07-12T00:00:00.000Z');

    const result = cleanupEvenHubStorage(audioDir, 7 * DAY_MS, {
      now,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.expiredTurns).toBe(1);
    expect(getEvenTurnById('old-draft')).toBeUndefined();
    expect(getEvenTurnById('recent-draft')?.state).toBe(
      'awaiting_confirmation',
    );
  });
});
