import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getActiveEvenDevices,
  transitionEvenTurnState,
} from '../db.js';
import { createEvenPairingCode } from './pairing.js';
import { EvenHubServer } from './server.js';

describe('EvenHub LAN API', () => {
  let server: EvenHubServer;
  let audioDir: string;

  beforeEach(async () => {
    _initTestDatabase();
    audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-evenhub-'));
    server = new EvenHubServer({
      host: '127.0.0.1',
      port: 0,
      audioDir,
      processor: {
        async process(turn) {
          transitionEvenTurnState(turn.id, 'accepted', 'completed', {
            transcript: 'fixture audio',
            answer: 'Fixture answer from the injected processor.',
            completedAt: new Date().toISOString(),
          });
        },
      },
    });
  });

  afterEach(() => {
    _closeDatabase();
    fs.rmSync(audioDir, { recursive: true, force: true });
  });

  async function pair(): Promise<string> {
    const pairing = createEvenPairingCode();
    const response = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/pair',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, deviceName: 'G2 simulator' }),
    });
    expect(response.status).toBe(201);
    const body = response.body as { token: string };
    return body.token;
  }

  it('pairs, durably accepts a turn, completes it, and replays safely', async () => {
    const token = await pair();
    const [storedDevice] = getActiveEvenDevices();
    expect(storedDevice.token_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(storedDevice.token_sha256).not.toBe(token);

    const idempotencyKey = randomUUID();
    const audio = new Uint8Array(8_000);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'audio/L16;rate=16000;channels=1',
      'Idempotency-Key': idempotencyKey,
      'X-Audio-Duration-Ms': '250',
    };
    const accepted = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/turns',
      headers,
      body: audio,
    });
    expect(accepted.status).toBe(202);
    const acceptedTurn = accepted.body as {
      turnId: string;
      state: string;
    };
    expect(acceptedTurn.state).toBe('accepted');
    expect(
      fs.existsSync(path.join(audioDir, `${acceptedTurn.turnId}.pcm`)),
    ).toBe(true);

    let completed: { state: string; answer?: string } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await server.inject({
        method: 'GET',
        pathname: `/api/even/v1/turns/${acceptedTurn.turnId}`,
        headers: { Authorization: `Bearer ${token}` },
      });
      completed = result.body as typeof completed;
      if (completed?.state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(completed).toMatchObject({
      state: 'completed',
      answer: 'Fixture answer from the injected processor.',
    });

    const replay = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/turns',
      headers,
      body: audio,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers['Idempotency-Replayed']).toBe('true');
    expect(replay.body as object).toMatchObject({
      turnId: acceptedTurn.turnId,
      state: 'completed',
    });

    const mismatch = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/turns',
      headers,
      body: new Uint8Array(8_000).fill(1),
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body as object).toMatchObject({
      error: { code: 'idempotency_payload_mismatch' },
    });
  });

  it('locks an address after five failed pairing attempts', async () => {
    const pairing = createEvenPairingCode();
    const wrongCode = pairing.code === '999999' ? '000000' : '999999';
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await server.inject({
        method: 'POST',
        pathname: '/api/even/v1/pair',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: wrongCode, deviceName: 'G2 simulator' }),
      });
      expect(response.status).toBe(attempt === 5 ? 429 : 401);
    }

    const blocked = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/pair',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, deviceName: 'G2 simulator' }),
    });
    expect(blocked.status).toBe(429);
  });

  it('rejects malformed audio before creating a turn', async () => {
    const token = await pair();
    const response = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/turns',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Idempotency-Key': randomUUID(),
        'X-Audio-Duration-Ms': '250',
      },
      body: new Uint8Array(8_000),
    });
    expect(response.status).toBe(415);
    expect(fs.readdirSync(audioDir)).toHaveLength(0);
  });

  it('rejects incomplete signed 16-bit samples', async () => {
    const token = await pair();
    const response = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/turns',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'audio/L16;rate=16000;channels=1',
        'Idempotency-Key': randomUUID(),
        'X-Audio-Duration-Ms': '250',
      },
      body: new Uint8Array(8_001),
    });
    expect(response.status).toBe(422);
    expect(response.body as object).toMatchObject({
      error: { code: 'invalid_audio', retryable: false },
    });
    expect(fs.readdirSync(audioDir)).toHaveLength(0);
  });
});
