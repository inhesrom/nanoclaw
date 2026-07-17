import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {
  _closeDatabase,
  _initTestDatabase,
  getEvenTurnsByStates,
} from '../db.js';
import { createEvenPairingCode } from './pairing.js';
import { EvenHubServer } from './server.js';
import { EvenStreamTicketStore, StreamProtocolError } from './streaming.js';
import type {
  SttSnapshot,
  SttStream,
  SttStreamingProvider,
} from './stt-client.js';

const allStates = [
  'accepted',
  'transcribing',
  'dispatching',
  'queued',
  'running',
  'completed',
  'failed',
] as const;

describe('EvenHub streaming protocol', () => {
  let audioDir: string;
  let server: EvenHubServer;
  let provider: FakeStreamingProvider;

  beforeEach(async () => {
    _initTestDatabase();
    audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-stream-'));
    provider = new FakeStreamingProvider();
    server = new EvenHubServer({
      host: '127.0.0.1',
      port: 0,
      audioDir,
      publicOrigin: 'https://nanoclaw.local',
      streamingStt: provider,
    });
    await server.start();
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
      body: JSON.stringify({
        code: pairing.code,
        deviceName: 'G2 stream test',
      }),
    });
    return (response.body as { token: string }).token;
  }

  async function ticket(token: string, idempotencyKey = randomUUID()) {
    const response = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/stt-sessions',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ idempotencyKey }),
    });
    expect(response.status).toBe(201);
    return {
      idempotencyKey,
      ...(response.body as { sessionId: string; ticket: string }),
    };
  }

  function connect(origin = 'https://nanoclaw.local'): WebSocket {
    const address = server.address();
    return new WebSocket(
      `ws://${address.host}:${address.port}/api/even/v1/stt-stream`,
      { origin },
    );
  }

  it('authenticates once, emits complete snapshots, and durably finalizes', async () => {
    const token = await pair();
    const session = await ticket(token);
    const socket = connect();
    const messages = collectMessages(socket);
    await opened(socket);
    socket.send(
      JSON.stringify({
        type: 'start',
        version: 1,
        session: session.sessionId,
        ticket: session.ticket,
        format: { encoding: 's16le', sampleRate: 16_000, channels: 1 },
      }),
    );
    await expect(nextType(messages, 'ready')).resolves.toMatchObject({
      version: 1,
    });

    provider.snapshot({ finalText: 'set a', interimText: 'timer' });
    await expect(nextType(messages, 'snapshot')).resolves.toEqual({
      type: 'snapshot',
      finalText: 'set a',
      interimText: 'timer',
    });
    const pcm = Buffer.alloc(8_000);
    socket.send(frame(0, pcm));
    socket.send(
      JSON.stringify({
        type: 'finish',
        nextSequence: 1,
        durationMs: 250,
        sha256: sha256(pcm),
      }),
    );
    const final = await nextType(messages, 'final');
    expect(final).toMatchObject({
      state: 'dispatching',
      transcript: 'set a timer',
    });
    expect(provider.audio).toEqual(pcm);
    expect(getEvenTurnsByStates(allStates)).toHaveLength(1);
    expect(fs.readdirSync(audioDir)).toEqual([]);
  });

  it('rejects sequence gaps and removes the owner-only partial file', async () => {
    const token = await pair();
    const session = await ticket(token);
    const socket = connect();
    const messages = collectMessages(socket);
    await opened(socket);
    socket.send(startMessage(session));
    await nextType(messages, 'ready');
    const part = fs.readdirSync(audioDir)[0];
    expect(fs.statSync(path.join(audioDir, part)).mode & 0o777).toBe(0o600);
    socket.send(frame(1, Buffer.alloc(8_000)));
    await expect(nextType(messages, 'error')).resolves.toMatchObject({
      code: 'sequence_mismatch',
      retryable: false,
      message: 'Streaming session rejected',
    });
    await closed(socket);
    expect(getEvenTurnsByStates(allStates)).toEqual([]);
    expect(fs.readdirSync(audioDir)).toEqual([]);
  });

  it('rejects ticket replay and invalid browser origins without retaining audio', async () => {
    const token = await pair();
    const session = await ticket(token);
    const first = connect();
    const firstMessages = collectMessages(first);
    await opened(first);
    first.send(startMessage(session));
    await nextType(firstMessages, 'ready');

    const replay = connect();
    const replayMessages = collectMessages(replay);
    await opened(replay);
    replay.send(startMessage(session));
    await expect(nextType(replayMessages, 'error')).resolves.toMatchObject({
      code: 'ticket_replayed',
    });

    const invalidOrigin = connect('https://attacker.invalid');
    await expect(opened(invalidOrigin)).rejects.toThrow();
    first.close();
    await closed(first);
    expect(getEvenTurnsByStates(allStates)).toEqual([]);
    expect(fs.readdirSync(audioDir)).toEqual([]);
  });

  it('accepts the EvenHub loopback WebView origin and rejects lookalikes', async () => {
    const token = await pair();
    const session = await ticket(token);
    const allowed = connect('http://127.0.0.1:60855');
    const messages = collectMessages(allowed);
    await opened(allowed);
    allowed.send(startMessage(session));
    await expect(nextType(messages, 'ready')).resolves.toMatchObject({
      version: 1,
    });
    allowed.close();
    await closed(allowed);

    for (const origin of [
      'http://localhost:60855',
      'http://127.0.0.2:60855',
      'https://127.0.0.1:60855',
      'http://127.0.0.1',
      'http://127.0.0.1:80',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:60855/',
    ]) {
      const rejected = connect(origin);
      await expect(opened(rejected), origin).rejects.toThrow();
    }
    expect(getEvenTurnsByStates(allStates)).toEqual([]);
    expect(fs.readdirSync(audioDir)).toEqual([]);
  });

  it('allows only one active stream for a device', async () => {
    const token = await pair();
    const firstSession = await ticket(token);
    const secondSession = await ticket(token);
    const first = connect();
    const firstMessages = collectMessages(first);
    await opened(first);
    first.send(startMessage(firstSession));
    await nextType(firstMessages, 'ready');

    const second = connect();
    const secondMessages = collectMessages(second);
    await opened(second);
    second.send(startMessage(secondSession));

    await expect(nextType(secondMessages, 'error')).resolves.toMatchObject({
      code: 'stream_limit',
      retryable: true,
    });
    await closed(second);
    first.close();
    await closed(first);
    expect(getEvenTurnsByStates(allStates)).toEqual([]);
    expect(fs.readdirSync(audioDir)).toEqual([]);
  });

  it('lets fallback replay a committed stream when the final response is lost', async () => {
    const token = await pair();
    const session = await ticket(token);
    const socket = connect();
    const messages = collectMessages(socket);
    await opened(socket);
    socket.send(startMessage(session));
    await nextType(messages, 'ready');
    const pcm = Buffer.alloc(8_000);
    socket.send(frame(0, pcm));
    socket.send(
      JSON.stringify({
        type: 'finish',
        nextSequence: 1,
        durationMs: 250,
        sha256: sha256(pcm),
      }),
    );
    await nextType(messages, 'final');

    const replay = await server.inject({
      method: 'POST',
      pathname: '/api/even/v1/turns',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'audio/L16;rate=16000;channels=1',
        'Idempotency-Key': session.idempotencyKey,
        'X-Audio-Duration-Ms': '250',
      },
      body: pcm,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers['Idempotency-Replayed']).toBe('true');
    expect(replay.body).toMatchObject({
      state: 'dispatching',
      transcript: 'set a timer',
    });
    expect(getEvenTurnsByStates(allStates)).toHaveLength(1);
  });

  it.each([
    {
      name: 'odd PCM',
      send(socket: WebSocket) {
        socket.send(Buffer.alloc(5));
      },
      code: 'invalid_audio_frame',
    },
    {
      name: 'whole-PCM hash mismatch',
      send(socket: WebSocket) {
        socket.send(frame(0, Buffer.alloc(8_000)));
        socket.send(
          JSON.stringify({
            type: 'finish',
            nextSequence: 1,
            durationMs: 250,
            sha256: '0'.repeat(64),
          }),
        );
      },
      code: 'audio_hash_mismatch',
    },
    {
      name: 'duration mismatch',
      send(socket: WebSocket) {
        const pcm = Buffer.alloc(8_000);
        socket.send(frame(0, pcm));
        socket.send(
          JSON.stringify({
            type: 'finish',
            nextSequence: 1,
            durationMs: 300,
            sha256: sha256(pcm),
          }),
        );
      },
      code: 'audio_duration_mismatch',
    },
  ])('rejects $name and cleans partial audio', async ({ send, code }) => {
    const token = await pair();
    const session = await ticket(token);
    const socket = connect();
    const messages = collectMessages(socket);
    await opened(socket);
    socket.send(startMessage(session));
    await nextType(messages, 'ready');

    send(socket);

    await expect(nextType(messages, 'error')).resolves.toMatchObject({ code });
    await closed(socket);
    expect(getEvenTurnsByStates(allStates)).toEqual([]);
    expect(fs.readdirSync(audioDir)).toEqual([]);
  });

  it('closes an oversize frame and cleans partial audio', async () => {
    const token = await pair();
    const session = await ticket(token);
    const socket = connect();
    const messages = collectMessages(socket);
    await opened(socket);
    socket.send(startMessage(session));
    await nextType(messages, 'ready');

    socket.send(frame(0, Buffer.alloc(960_002)));

    await closed(socket);
    expect(getEvenTurnsByStates(allStates)).toEqual([]);
    expect(fs.readdirSync(audioDir)).toEqual([]);
  });
});

describe('streaming ticket lifetime', () => {
  it('expires consumed tickets and still reports replay before expiry', () => {
    let now = Date.parse('2026-07-17T00:00:00.000Z');
    const store = new EvenStreamTicketStore(() => now, 60_000);
    const device = {
      id: 'device-1',
      name: 'G2',
      token_sha256: '0'.repeat(64),
      created_at: new Date(now).toISOString(),
      last_used_at: new Date(now).toISOString(),
      revoked_at: null,
    };
    const issued = store.create(device, randomUUID());
    store.consume(issued.sessionId, issued.ticket);

    expect(() => store.consume(issued.sessionId, issued.ticket)).toThrowError(
      expect.objectContaining<Partial<StreamProtocolError>>({
        code: 'ticket_replayed',
      }),
    );
    now += 60_001;
    expect(() => store.consume(issued.sessionId, issued.ticket)).toThrowError(
      expect.objectContaining<Partial<StreamProtocolError>>({
        code: 'ticket_expired',
      }),
    );

    const fresh = store.create(device, randomUUID());
    expect(() => store.consume(fresh.sessionId, 'malformed')).toThrowError(
      expect.objectContaining<Partial<StreamProtocolError>>({
        code: 'invalid_ticket',
      }),
    );
    expect(store.consume(fresh.sessionId, fresh.ticket)).toMatchObject({
      deviceId: device.id,
      consumed: true,
    });
    store.revokeDevice(device.id);
  });
});

class FakeStreamingProvider implements SttStreamingProvider {
  audio = Buffer.alloc(0);
  private onSnapshot?: (snapshot: SttSnapshot) => void;

  async connect(
    onSnapshot: (snapshot: SttSnapshot) => void,
  ): Promise<SttStream> {
    this.onSnapshot = onSnapshot;
    return {
      addAudio: (pcm) => {
        this.audio = Buffer.concat([this.audio, pcm]);
      },
      finish: async () => ({ text: 'set a timer', processingMs: 42 }),
      close: vi.fn(),
    };
  }

  snapshot(snapshot: SttSnapshot): void {
    this.onSnapshot?.(snapshot);
  }
}

function startMessage(session: { sessionId: string; ticket: string }): string {
  return JSON.stringify({
    type: 'start',
    version: 1,
    session: session.sessionId,
    ticket: session.ticket,
    format: { encoding: 's16le', sampleRate: 16_000, channels: 1 },
  });
}

function frame(sequence: number, pcm: Uint8Array): Buffer {
  const result = Buffer.alloc(pcm.byteLength + 4);
  result.writeUInt32BE(sequence, 0);
  result.set(pcm, 4);
  return result;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

function collectMessages(socket: WebSocket): AsyncIterableIterator<unknown> {
  const queue: unknown[] = [];
  const waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    const value = JSON.parse(data.toString()) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter({ value, done: false });
    else queue.push(value);
  });
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      const value = queue.shift();
      if (value !== undefined) return Promise.resolve({ value, done: false });
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function nextType(
  messages: AsyncIterableIterator<unknown>,
  type: string,
): Promise<Record<string, unknown>> {
  for await (const message of messages) {
    const value = message as Record<string, unknown>;
    if (value.type === type) return value;
  }
  throw new Error(`socket closed before ${type}`);
}
