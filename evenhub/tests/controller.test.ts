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

const draftTurn: ServerTurn = {
  turnId: 'turn-1',
  state: 'awaiting_confirmation',
  transcript: 'fixture audio',
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:01.000Z',
  pollAfterMs: 500,
};

const completedTurn: ServerTurn = {
  ...draftTurn,
  state: 'completed',
  answer: 'Exact café answer 👓 — unchanged',
  completedAt: '2026-07-16T00:00:02.000Z',
};

function api(overrides: Partial<EvenHubApiPort> = {}): EvenHubApiPort {
  return {
    async checkReady(): Promise<void> {},
    async pair(): Promise<PairResult> {
      return { deviceId: 'device-1', token: 'token' };
    },
    async submitTurn(): Promise<ServerTurn> {
      return draftTurn;
    },
    async getTurn(): Promise<ServerTurn> {
      return draftTurn;
    },
    async confirmTurn(_token, _turnId, decision): Promise<ServerTurn> {
      return decision === 'discard'
        ? { ...draftTurn, state: 'discarded' }
        : { ...draftTurn, state: 'dispatching' };
    },
    ...overrides,
  };
}

describe('TurnController', () => {
  it('blocks recording until private-host readiness succeeds on retry', async () => {
    const storage = new MemoryStorage(new Map([[STORAGE_KEYS.token, 'token']]));
    let connected = false;
    const checkReady = vi.fn(async () => {
      if (!connected) {
        throw new EvenHubApiError(
          0,
          'tailscale_unavailable',
          'Connect Tailscale and retry.',
          true,
        );
      }
    });
    const controller = new TurnController({
      api: api({ checkReady }),
      storage,
      onState: () => undefined,
    });

    await controller.boot();
    expect(controller.state).toMatchObject({ kind: 'error', retryable: true });
    controller.startRecording();
    expect(controller.state.kind).toBe('error');

    connected = true;
    await controller.retry();
    expect(controller.state.kind).toBe('ready');
  });

  it('restores an unresolved draft after reload and stops polling for a decision', async () => {
    const storage = activeStorage();
    const getTurn = vi.fn(async () => draftTurn);
    const controller = new TurnController({
      api: api({ getTurn }),
      storage,
      onState: () => undefined,
      delay: async () => undefined,
    });

    await controller.boot();
    await waitForState(controller, 'review');

    expect(controller.state).toMatchObject({
      kind: 'review',
      transcript: 'fixture audio',
      choiceOpen: true,
      choice: 'send',
    });
    expect(getTurn).toHaveBeenCalledOnce();
    expect(storage.values.get(STORAGE_KEYS.activeTurnId)).toBe('turn-1');
    expect(controller.state.session.turns).toEqual([]);
  });

  it('submits retained audio but never confirms the draft implicitly', async () => {
    const confirmTurn = vi.fn<EvenHubApiPort['confirmTurn']>();
    const controller = new TurnController({
      api: api({ confirmTurn }),
      storage: tokenStorage(),
      onState: () => undefined,
      createIdempotencyKey: () => 'key-1',
    });
    await controller.boot();
    controller.startRecording();
    controller.recordingStopped();

    await controller.submit(new Uint8Array(8_000), 250);

    expect(controller.state).toMatchObject({
      kind: 'review',
      choiceOpen: true,
      choice: 'send',
    });
    expect(confirmTurn).not.toHaveBeenCalled();
  });

  it('opens the streamed final draft only after finish returns it', async () => {
    let releaseFinal!: () => void;
    const pendingFinal = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const finish = vi.fn<LiveTurn['finish']>(async () => {
      await pendingFinal;
      return draftTurn;
    });
    const controller = new TurnController({
      api: api({
        startLiveTurn: () => ({ push: vi.fn(), finish, abort: vi.fn() }),
      }),
      storage: tokenStorage(),
      onState: () => undefined,
      createIdempotencyKey: () => 'stream-key',
    });
    await controller.boot();
    controller.startRecording();
    controller.recordingStopped();

    const submitting = controller.submit(new Uint8Array(8_000), 250);
    expect(controller.state.kind).toBe('stopping');
    releaseFinal();
    await submitting;

    expect(controller.state).toMatchObject({
      kind: 'review',
      transcript: 'fixture audio',
      choiceOpen: true,
      choice: 'send',
    });
  });

  it('sends only after confirmation and adds the exact reply to the session feed', async () => {
    const confirmTurn = vi.fn(async () => ({
      ...draftTurn,
      state: 'dispatching' as const,
    }));
    let polls = 0;
    const getTurn = vi.fn(async () => {
      polls += 1;
      return polls === 1 ? draftTurn : completedTurn;
    });
    const storage = activeStorage();
    const controller = new TurnController({
      api: api({ confirmTurn, getTurn }),
      storage,
      onState: () => undefined,
      delay: async () => undefined,
    });
    await controller.boot();
    await waitForState(controller, 'review');

    const result = await controller.confirm('send');
    await waitForState(controller, 'ready');

    expect(result).toBe('send');
    expect(confirmTurn).toHaveBeenCalledWith('token', 'turn-1', 'send');
    expect(controller.state.session.turns).toEqual([
      {
        turnId: 'turn-1',
        transcript: 'fixture audio',
        reply: 'Exact café answer 👓 — unchanged',
      },
    ]);
    expect(storage.values.get(STORAGE_KEYS.activeTurnId)).toBe('');
  });

  it('discards only after host acknowledgement and leaves no session turn', async () => {
    const storage = activeStorage();
    const controller = new TurnController({
      api: api(),
      storage,
      onState: () => undefined,
      delay: async () => undefined,
    });
    await controller.boot();
    await waitForState(controller, 'review');

    expect(await controller.confirm('discard')).toBe('discard');
    expect(controller.state.kind).toBe('ready');
    expect(controller.state.session.turns).toEqual([]);
    expect(storage.values.get(STORAGE_KEYS.activeTurnId)).toBe('');
  });

  it('keeps a draft reviewable when confirmation fails', async () => {
    const controller = new TurnController({
      api: api({
        async confirmTurn() {
          throw new EvenHubApiError(
            0,
            'tailscale_unavailable',
            'Connect Tailscale and retry.',
            true,
          );
        },
      }),
      storage: activeStorage(),
      onState: () => undefined,
      delay: async () => undefined,
    });
    await controller.boot();
    await waitForState(controller, 'review');

    await expect(controller.confirm('send')).rejects.toMatchObject({
      code: 'tailscale_unavailable',
    });
    expect(controller.state).toMatchObject({
      kind: 'review',
      transcript: 'fixture audio',
      notice: 'Connect Tailscale and retry. Draft not sent.',
    });
  });

  it('lets the first simultaneous local decision win', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const confirmTurn = vi.fn(async (_token, _turnId, decision) => {
      await pending;
      return {
        ...draftTurn,
        state:
          decision === 'send'
            ? ('dispatching' as const)
            : ('discarded' as const),
      };
    });
    let polls = 0;
    const controller = new TurnController({
      api: api({
        confirmTurn,
        getTurn: async () => {
          polls += 1;
          return polls === 1 ? draftTurn : completedTurn;
        },
      }),
      storage: activeStorage(),
      onState: () => undefined,
      delay: async () => undefined,
    });
    await controller.boot();
    await waitForState(controller, 'review');

    const first = controller.confirm('send');
    const second = controller.confirm('discard');
    release();

    expect(await first).toBe('send');
    expect(await second).toBe('send');
    expect(confirmTurn).toHaveBeenCalledOnce();
    expect(confirmTurn).toHaveBeenCalledWith('token', 'turn-1', 'send');
  });

  it('falls back with complete retained PCM and the same key', async () => {
    const finish = vi.fn<LiveTurn['finish']>(async () => {
      throw new Error('stream disconnected');
    });
    const submitTurn = vi.fn(async () => ({
      ...draftTurn,
      state: 'accepted' as const,
      transcript: undefined,
    }));
    const getTurn = vi.fn(async () => draftTurn);
    const controller = new TurnController({
      api: api({
        startLiveTurn: () => ({ push: vi.fn(), finish, abort: vi.fn() }),
        submitTurn,
        getTurn,
      }),
      storage: tokenStorage(),
      onState: () => undefined,
      createIdempotencyKey: () => 'hybrid-key',
    });
    const pcm = new Uint8Array(8_000);
    await controller.boot();
    controller.startRecording();
    controller.recordingStopped();

    await controller.submit(pcm, 250);

    expect(finish).toHaveBeenCalledWith(pcm, 250);
    expect(submitTurn).toHaveBeenCalledWith('token', pcm, 250, 'hybrid-key');
    expect(getTurn).toHaveBeenCalledOnce();
    expect(controller.state).toMatchObject({
      kind: 'review',
      choiceOpen: true,
      choice: 'send',
    });
  });
});

function tokenStorage(): MemoryStorage {
  return new MemoryStorage(new Map([[STORAGE_KEYS.token, 'token']]));
}

function activeStorage(): MemoryStorage {
  return new MemoryStorage(
    new Map([
      [STORAGE_KEYS.token, 'token'],
      [STORAGE_KEYS.activeTurnId, 'turn-1'],
      [STORAGE_KEYS.activeIdempotencyKey, 'key-1'],
    ]),
  );
}

async function waitForState(
  controller: TurnController,
  kind: AppState['kind'],
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (controller.state.kind === kind) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Controller did not reach ${kind}`);
}
