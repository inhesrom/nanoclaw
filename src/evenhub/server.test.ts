import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getActiveEvenDevices,
  getEvenTurnById,
  transitionEvenTurnState,
} from '../db.js';
import { createEvenPairingCode } from './pairing.js';
import { EVENHUB_RELEASE_VERSION, EvenHubServer } from './server.js';

describe('EvenHub LAN API', () => {
  let server: EvenHubServer;
  let audioDir: string;
  let dispatchWakes: number;

  beforeEach(async () => {
    _initTestDatabase();
    dispatchWakes = 0;
    audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-evenhub-'));
    server = new EvenHubServer({
      host: '127.0.0.1',
      port: 0,
      audioDir,
      onDispatchReady: () => {
        dispatchWakes += 1;
      },
      processor: {
        async process(turn) {
          transitionEvenTurnState(turn.id, 'accepted', 'transcribing');
          transitionEvenTurnState(
            turn.id,
            'transcribing',
            'awaiting_confirmation',
            {
              transcript: 'fixture audio',
            },
          );
        },
      },
    });
  });

  afterEach(async () => {
    await server.stop();
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

  it('stops at confirmation, dispatches only after Send, and replays safely', async () => {
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
      'X-EvenHub-Protocol-Version': '2',
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

    let draft:
      | { state: string; transcript?: string; answer?: string }
      | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await server.inject({
        method: 'GET',
        pathname: `/api/even/v1/turns/${acceptedTurn.turnId}`,
        headers: protocolAuth(token),
      });
      draft = result.body as typeof draft;
      if (draft?.state === 'awaiting_confirmation') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(draft).toMatchObject({
      state: 'awaiting_confirmation',
      transcript: 'fixture audio',
    });
    expect(draft?.answer).toBeUndefined();
    expect(dispatchWakes).toBe(0);

    const sent = await server.inject({
      method: 'POST',
      pathname: `/api/even/v1/turns/${acceptedTurn.turnId}/confirmation`,
      headers: { ...protocolAuth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'send' }),
    });
    expect(sent.body).toMatchObject({ state: 'dispatching' });
    expect(dispatchWakes).toBe(1);

    transitionEvenTurnState(acceptedTurn.turnId, 'dispatching', 'queued');
    transitionEvenTurnState(acceptedTurn.turnId, 'queued', 'running');
    transitionEvenTurnState(acceptedTurn.turnId, 'running', 'completed', {
      answer: 'Fixture answer from the injected processor.',
      completedAt: new Date().toISOString(),
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

  it('reports approved health metadata and gates uploads on readiness', async () => {
    let dependencies = {
      database: 'up' as 'up' | 'down',
      stt: 'down' as 'up' | 'down',
      whatsapp: 'down' as 'up' | 'down',
    };
    server = new EvenHubServer({
      host: '127.0.0.1',
      port: 0,
      audioDir,
      version: '1.2.52',
      readiness: { snapshot: async () => dependencies },
    });

    const health = await server.inject({
      method: 'GET',
      pathname: '/api/even/v1/healthz',
    });
    expect(health).toMatchObject({
      status: 200,
      body: {
        status: 'degraded',
        version: '1.2.52',
        stt: 'down',
        whatsapp: 'down',
      },
    });
    expect(Object.keys(health.body as object).sort()).toEqual([
      'status',
      'stt',
      'version',
      'whatsapp',
    ]);

    const notReady = await server.inject({
      method: 'GET',
      pathname: '/api/even/v1/readyz',
      headers: protocolHeader(),
    });
    expect(notReady).toMatchObject({
      status: 503,
      body: {
        status: 'not_ready',
        components: ['stt', 'whatsapp'],
        protocolVersion: 2,
      },
    });

    const capabilities = await server.inject({
      method: 'GET',
      pathname: '/api/even/v1/capabilities',
      headers: protocolHeader(),
    });
    expect(capabilities).toMatchObject({
      status: 200,
      body: {
        protocolVersion: 2,
        capabilities: { voice: false, text: false },
        unavailable: {
          voice: ['stt', 'whatsapp'],
          text: ['whatsapp'],
        },
      },
    });

    dependencies = { database: 'up', stt: 'down', whatsapp: 'up' };
    expect(
      await server.inject({
        method: 'GET',
        pathname: '/api/even/v1/capabilities',
        headers: protocolHeader(),
      }),
    ).toMatchObject({
      status: 200,
      body: {
        capabilities: { voice: false, text: true },
        unavailable: { voice: ['stt'], text: [] },
      },
    });

    dependencies = { database: 'down', stt: 'up', whatsapp: 'up' };
    expect(
      await server.inject({
        method: 'GET',
        pathname: '/api/even/v1/capabilities',
        headers: protocolHeader(),
      }),
    ).toMatchObject({
      status: 200,
      body: {
        capabilities: { voice: false, text: false },
        unavailable: { voice: ['database'], text: ['database'] },
      },
    });

    const token = await pair();
    dependencies = { database: 'up', stt: 'down', whatsapp: 'up' };
    const rejected = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/turns',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'audio/L16;rate=16000;channels=1',
        'Idempotency-Key': randomUUID(),
        'X-Audio-Duration-Ms': '250',
        'X-EvenHub-Protocol-Version': '2',
      },
      body: new Uint8Array(8_000),
    });
    expect(rejected).toMatchObject({
      status: 503,
      body: { error: { code: 'not_ready', retryable: true } },
    });
    expect(fs.readdirSync(audioDir)).toHaveLength(0);

    const typed = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/text-turns',
      headers: {
        ...protocolAuth(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ idempotencyKey: randomUUID(), text: 'typed' }),
    });
    expect(typed).toMatchObject({
      status: 201,
      body: { state: 'dispatching', transcript: 'typed' },
    });

    dependencies = { database: 'up', stt: 'up', whatsapp: 'up' };
    const ready = await server.inject({
      method: 'GET',
      pathname: '/api/even/v1/readyz',
      headers: protocolHeader(),
    });
    expect(ready).toMatchObject({
      status: 200,
      body: {
        status: 'ready',
        components: ['api', 'database', 'stt', 'whatsapp'],
        protocolVersion: 2,
      },
    });
  });

  it('creates normalized text turns directly in dispatching and replays them exactly once', async () => {
    const token = await pair();
    const idempotencyKey = randomUUID();
    const request = {
      method: 'POST',
      pathname: '/api/even/v1/text-turns',
      headers: {
        ...protocolAuth(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotencyKey,
        text: '  keep café 👓\r\nsecond line  ',
      }),
    };

    const created = await server.inject(request);
    expect(created).toMatchObject({
      status: 201,
      body: {
        state: 'dispatching',
        transcript: 'keep café 👓\nsecond line',
      },
    });
    const { turnId } = created.body as { turnId: string };
    expect(getEvenTurnById(turnId)).toMatchObject({
      input_kind: 'text',
      audio_path: `text:${turnId}`,
      audio_duration_ms: 0,
      state: 'dispatching',
      confirmation_decision: 'send',
      transcript: 'keep café 👓\nsecond line',
    });
    expect(dispatchWakes).toBe(1);
    expect(fs.readdirSync(audioDir)).toHaveLength(0);

    const replay = await server.inject(request);
    expect(replay.status).toBe(200);
    expect(replay.headers['Idempotency-Replayed']).toBe('true');
    expect(replay.body).toMatchObject({ turnId, state: 'dispatching' });
    expect(dispatchWakes).toBe(1);

    const mismatch = await server.inject({
      ...request,
      body: JSON.stringify({ idempotencyKey, text: 'different' }),
    });
    expect(mismatch).toMatchObject({
      status: 409,
      body: { error: { code: 'idempotency_payload_mismatch' } },
    });
  });

  it('authenticates, protocol-gates, and validates typed prompts by Unicode code point', async () => {
    const token = await pair();
    const body = JSON.stringify({ idempotencyKey: randomUUID(), text: 'hi' });
    const unauthenticated = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/text-turns',
      headers: {
        'Content-Type': 'application/json',
        ...protocolHeader(),
      },
      body,
    });
    expect(unauthenticated.status).toBe(401);

    const oldClient = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/text-turns',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-EvenHub-Protocol-Version': '1',
      },
      body,
    });
    expect(oldClient.status).toBe(426);

    for (const text of ['', ' \r\n ']) {
      const blank = await server.inject({
        method: 'POST',
        pathname: '/api/even/v1/text-turns',
        headers: {
          ...protocolAuth(token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ idempotencyKey: randomUUID(), text }),
      });
      expect(blank).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_text' } },
      });
    }

    const tooLong = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/text-turns',
      headers: {
        ...protocolAuth(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        text: '👓'.repeat(2_001),
      }),
    });
    expect(tooLong).toMatchObject({
      status: 413,
      body: { error: { code: 'text_too_long' } },
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
        'X-EvenHub-Protocol-Version': '2',
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
        'X-EvenHub-Protocol-Version': '2',
      },
      body: new Uint8Array(8_001),
    });
    expect(response.status).toBe(422);
    expect(response.body as object).toMatchObject({
      error: { code: 'invalid_audio', retryable: false },
    });
    expect(fs.readdirSync(audioDir)).toHaveLength(0);
  });

  it('revokes the previous token and preserves turn ownership on re-pair', async () => {
    const firstToken = await pair();
    const accepted = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/turns',
      headers: {
        Authorization: `Bearer ${firstToken}`,
        'Content-Type': 'audio/L16;rate=16000;channels=1',
        'Idempotency-Key': randomUUID(),
        'X-Audio-Duration-Ms': '250',
        'X-EvenHub-Protocol-Version': '2',
      },
      body: new Uint8Array(8_000),
    });
    const { turnId } = accepted.body as { turnId: string };

    const replacementToken = await pair();
    const revoked = await server.inject({
      method: 'GET',
      pathname: `/api/even/v1/turns/${turnId}`,
      headers: protocolAuth(firstToken),
    });
    expect(revoked.status).toBe(401);

    const notOwned = await server.inject({
      method: 'GET',
      pathname: `/api/even/v1/turns/${turnId}`,
      headers: protocolAuth(replacementToken),
    });
    expect(notOwned.status).toBe(404);
    const confirmationNotOwned = await server.inject({
      method: 'POST',
      pathname: `/api/even/v1/turns/${turnId}/confirmation`,
      headers: {
        ...protocolAuth(replacementToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'send' }),
    });
    expect(confirmationNotOwned.status).toBe(404);
  });

  it('makes identical decisions idempotent and conflicting decisions safe', async () => {
    const token = await pair();
    const accepted = await createTurn(token);
    await waitForTurnState(accepted.turnId, 'awaiting_confirmation');
    const request = {
      method: 'POST',
      pathname: `/api/even/v1/turns/${accepted.turnId}/confirmation`,
      headers: { ...protocolAuth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'discard' }),
    };

    const discarded = await server.inject(request);
    expect(discarded.body).toMatchObject({ state: 'discarded' });
    const replay = await server.inject(request);
    expect(replay.status).toBe(200);
    expect(replay.headers['Confirmation-Replayed']).toBe('true');

    const conflict = await server.inject({
      ...request,
      body: JSON.stringify({ decision: 'send' }),
    });
    expect(conflict).toMatchObject({
      status: 409,
      body: { error: { code: 'turn_already_resolved' } },
    });
  });

  it('rejects old clients before accepting audio while health and pairing stay public', async () => {
    const health = await server.inject({
      method: 'GET',
      pathname: '/api/even/v1/healthz',
    });
    expect(health).toMatchObject({
      status: 200,
      body: { version: '0.4.2' },
    });
    expect(EVENHUB_RELEASE_VERSION).toBe('0.4.2');
    const token = await pair();

    const oldReady = await server.inject({
      method: 'GET',
      pathname: '/api/even/v1/readyz',
      headers: { 'X-EvenHub-Protocol-Version': '1' },
    });
    expect(oldReady).toMatchObject({
      status: 426,
      body: { error: { code: 'client_upgrade_required' } },
    });
    const oldCapabilities = await server.inject({
      method: 'GET',
      pathname: '/api/even/v1/capabilities',
      headers: { 'X-EvenHub-Protocol-Version': '1' },
    });
    expect(oldCapabilities.status).toBe(426);
    const oldTurn = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/turns',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'audio/L16;rate=16000;channels=1',
        'Idempotency-Key': randomUUID(),
        'X-Audio-Duration-Ms': '250',
        'X-EvenHub-Protocol-Version': '1',
      },
      body: new Uint8Array(8_000),
    });
    expect(oldTurn.status).toBe(426);
    expect(fs.readdirSync(audioDir)).toHaveLength(0);
  });

  async function createTurn(token: string): Promise<{ turnId: string }> {
    const response = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/turns',
      headers: {
        ...protocolAuth(token),
        'Content-Type': 'audio/L16;rate=16000;channels=1',
        'Idempotency-Key': randomUUID(),
        'X-Audio-Duration-Ms': '250',
      },
      body: new Uint8Array(8_000),
    });
    expect(response.status).toBe(202);
    return response.body as { turnId: string };
  }

  async function waitForTurnState(
    turnId: string,
    state: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (getEvenTurnById(turnId)?.state === state) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Turn did not reach ${state}`);
  }
});

function protocolHeader(): Record<string, string> {
  return { 'X-EvenHub-Protocol-Version': '2' };
}

function protocolAuth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...protocolHeader() };
}
