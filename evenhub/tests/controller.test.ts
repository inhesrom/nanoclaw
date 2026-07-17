import { describe, expect, it, vi } from 'vitest';

import {
  EvenHubApiError,
  type EvenHubApiPort,
  type LiveTurn,
  type PairResult,
} from '../src/api';
import { TurnController } from '../src/controller';
import type { AppState, ServerTurn } from '../src/state';
import { STORAGE_KEYS, type StoragePort } from '../src/storage';

class MemoryStorage implements StoragePort {
  constructor(readonly values = new Map<string, string>()) {}

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const completedTurn: ServerTurn = {
  turnId: 'turn-1',
  state: 'completed',
  transcript: 'fixture audio',
  answer: 'first page / second page',
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:01.000Z',
  completedAt: '2026-07-16T00:00:01.000Z',
  pollAfterMs: 500,
};

function api(overrides: Partial<EvenHubApiPort> = {}): EvenHubApiPort {
  return {
    async pair(): Promise<PairResult> {
      return { deviceId: 'device-1', token: 'token' };
    },
    async submitTurn(): Promise<ServerTurn> {
      return { ...completedTurn, state: 'accepted', answer: undefined };
    },
    async getTurn(): Promise<ServerTurn> {
      return completedTurn;
    },
    ...overrides,
  };
}

describe('TurnController', () => {
  it('resumes polling after reload and clears the durable active turn', async () => {
    const storage = new MemoryStorage(
      new Map([
        [STORAGE_KEYS.token, 'token'],
        [STORAGE_KEYS.activeTurnId, 'turn-1'],
        [STORAGE_KEYS.activeIdempotencyKey, 'key-1'],
      ]),
    );
    const controller = new TurnController({
      api: api(),
      storage,
      paginateAnswer: () => ['first page', 'second page'],
      onState: () => undefined,
      delay: async () => undefined,
    });

    await controller.boot();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (controller.state.kind === 'answer') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(controller.state).toMatchObject({
      kind: 'answer',
      turnId: 'turn-1',
      pages: ['first page', 'second page'],
    });
    expect(storage.values.get(STORAGE_KEYS.activeTurnId)).toBe('');
    expect(storage.values.get(STORAGE_KEYS.lastCompletedTurnId)).toBe('turn-1');
  });

  it('retries an ambiguous upload with the same idempotency key', async () => {
    const storage = new MemoryStorage(new Map([[STORAGE_KEYS.token, 'token']]));
    const keys: string[] = [];
    let attempts = 0;
    const controller = new TurnController({
      api: api({
        async submitTurn(_token, _pcm, _durationMs, key) {
          keys.push(key);
          attempts += 1;
          if (attempts === 1) throw new TypeError('connection reset');
          return { ...completedTurn, state: 'accepted', answer: undefined };
        },
      }),
      storage,
      paginateAnswer: () => ['answer'],
      onState: () => undefined,
      delay: async () => undefined,
      createIdempotencyKey: () => 'fixed-key',
    });
    await controller.boot();
    controller.startRecording();

    await controller.submit(new Uint8Array(8_000), 250);

    expect(keys).toEqual(['fixed-key', 'fixed-key']);
    expect(controller.state.kind).toBe('answer');
  });

  it('falls back with retained PCM and the same key when live finalization fails', async () => {
    const storage = new MemoryStorage(new Map([[STORAGE_KEYS.token, 'token']]));
    const pushed: Uint8Array[] = [];
    const finish = vi.fn<LiveTurn['finish']>(async () => {
      throw new Error('final response lost');
    });
    const submitTurn = vi.fn<EvenHubApiPort['submitTurn']>(
      async (_token, _pcm, _durationMs, _key) => completedTurn,
    );
    const startLiveTurn = vi.fn<NonNullable<EvenHubApiPort['startLiveTurn']>>(
      () => ({
        push: (pcm) => pushed.push(new Uint8Array(pcm)),
        finish,
        abort: vi.fn(),
      }),
    );
    const controller = new TurnController({
      api: api({ startLiveTurn, submitTurn }),
      storage,
      paginateAnswer: () => ['answer'],
      onState: () => undefined,
      createIdempotencyKey: () => 'hybrid-key',
    });
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await controller.boot();

    controller.startRecording(100);
    controller.streamPcm(pcm.subarray(0, 4));
    controller.recordingStopped();
    await controller.submit(pcm, 250);

    expect(startLiveTurn).toHaveBeenCalledWith(
      'token',
      'hybrid-key',
      expect.any(Function),
    );
    expect(pushed).toEqual([new Uint8Array([1, 2, 3, 4])]);
    expect(finish).toHaveBeenCalledWith(pcm, 250);
    expect(submitTurn).toHaveBeenCalledWith('token', pcm, 250, 'hybrid-key');
    expect(controller.state.kind).toBe('answer');
  });

  it('returns to ready after a retryable terminal STT failure', async () => {
    const storage = new MemoryStorage(
      new Map([
        [STORAGE_KEYS.token, 'token'],
        [STORAGE_KEYS.activeTurnId, 'turn-1'],
        [STORAGE_KEYS.activeIdempotencyKey, 'key-1'],
      ]),
    );
    const controller = new TurnController({
      api: api({
        async getTurn(): Promise<ServerTurn> {
          return {
            ...completedTurn,
            state: 'failed',
            answer: undefined,
            error: {
              code: 'stt_unavailable',
              message: 'Local speech recognition is unavailable.',
              retryable: true,
            },
          };
        },
      }),
      storage,
      paginateAnswer: () => [],
      onState: () => undefined,
      delay: async () => undefined,
    });

    await controller.boot();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (controller.state.kind === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(controller.state).toMatchObject({
      kind: 'error',
      retryable: true,
    });

    await controller.retry();

    expect(controller.state).toEqual({
      kind: 'ready',
      session: { turns: [], turn: 0 },
    });
  });

  it('uses server polling cadence, shows a 30-second notice, and retains a five-minute turn', async () => {
    const storage = new MemoryStorage(
      new Map([
        [STORAGE_KEYS.token, 'token'],
        [STORAGE_KEYS.activeTurnId, 'turn-1'],
        [STORAGE_KEYS.activeIdempotencyKey, 'key-1'],
      ]),
    );
    let clock = 0;
    const delays: number[] = [];
    const states: AppState[] = [];
    const controller = new TurnController({
      api: api({
        async getTurn(): Promise<ServerTurn> {
          return { ...completedTurn, state: 'running', answer: undefined };
        },
      }),
      storage,
      paginateAnswer: () => [],
      onState: (state) => states.push(state),
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length <= 10) clock += milliseconds;
        else if (delays.length === 11) clock = 31_000;
        else clock = 5 * 60_000;
      },
      now: () => clock,
    });

    await controller.boot();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (controller.state.kind === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(delays.slice(0, 10)).toEqual(new Array(10).fill(500));
    expect(delays[10]).toBe(1_000);
    expect(states).toContainEqual(
      expect.objectContaining({
        kind: 'thinking',
        notice: 'Still working—watch WhatsApp',
      }),
    );
    expect(controller.state).toMatchObject({
      kind: 'error',
      retryable: true,
      activeTurn: { id: 'turn-1' },
    });
    expect(storage.values.get(STORAGE_KEYS.activeTurnId)).toBe('turn-1');
  });

  it('clears an expired retained turn on 404 without resubmitting', async () => {
    const storage = new MemoryStorage(
      new Map([
        [STORAGE_KEYS.token, 'token'],
        [STORAGE_KEYS.activeTurnId, 'turn-expired'],
        [STORAGE_KEYS.activeIdempotencyKey, 'key-expired'],
      ]),
    );
    const submitTurn = vi.fn();
    const controller = new TurnController({
      api: api({
        submitTurn,
        async getTurn(): Promise<ServerTurn> {
          throw new EvenHubApiError(404, 'turn_not_found', 'Turn not found');
        },
      }),
      storage,
      paginateAnswer: () => [],
      onState: () => undefined,
      delay: async () => undefined,
    });

    await controller.boot();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (controller.state.kind === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(controller.state).toMatchObject({
      kind: 'error',
      message: 'Turn expired; record a new turn.',
      retryable: false,
    });
    expect(storage.values.get(STORAGE_KEYS.activeTurnId)).toBe('');
    expect(submitTurn).not.toHaveBeenCalled();
  });

  it('passes the exact API answer string into G2 pagination', async () => {
    const answer = 'Exact café answer 👓 — unchanged';
    const storage = new MemoryStorage(new Map([[STORAGE_KEYS.token, 'token']]));
    const paginateAnswer = vi.fn(() => [answer]);
    const controller = new TurnController({
      api: api({
        async submitTurn(): Promise<ServerTurn> {
          return { ...completedTurn, answer };
        },
      }),
      storage,
      paginateAnswer,
      onState: () => undefined,
      createIdempotencyKey: () => 'key-1',
    });
    await controller.boot();
    controller.startRecording();

    await controller.submit(new Uint8Array(8_000), 250);

    expect(paginateAnswer).toHaveBeenCalledWith(answer);
    expect(controller.state).toMatchObject({
      kind: 'answer',
      pages: [answer],
    });
  });
});
