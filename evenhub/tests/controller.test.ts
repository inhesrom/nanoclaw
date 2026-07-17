import { describe, expect, it } from 'vitest';

import type { EvenHubApiPort, PairResult } from '../src/api';
import { TurnController } from '../src/controller';
import type { ServerTurn } from '../src/state';
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
  id: 'turn-1',
  state: 'completed',
  transcript: 'fixture audio',
  answer: 'first page / second page',
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:01.000Z',
  completedAt: '2026-07-16T00:00:01.000Z',
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
});
