import { describe, expect, it, vi } from 'vitest';
import { AudioInputSource } from '@evenrealities/even_hub_sdk';

import type { EvenHubApiPort, LiveTurn } from '../src/api';
import { TurnController } from '../src/controller';
import { routeHubInteraction } from '../src/event-routing';
import { G2Recorder } from '../src/recorder';
import { STORAGE_KEYS, type StoragePort } from '../src/storage';

class MemoryStorage implements StoragePort {
  readonly values = new Map<string, string>([[STORAGE_KEYS.token, 'token']]);

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

describe('G2Recorder', () => {
  it('opens the live session before microphone readiness and streams each chunk', async () => {
    let releaseOpen!: () => void;
    const openPending = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const push = vi.fn<LiveTurn['push']>();
    const startLiveTurn = vi.fn<NonNullable<EvenHubApiPort['startLiveTurn']>>(
      () => ({ push, finish: vi.fn(), abort: vi.fn() }),
    );
    const controller = new TurnController({
      api: {
        checkReady: vi.fn(async () => undefined),
        pair: vi.fn(),
        submitTurn: vi.fn(),
        startLiveTurn,
        getTurn: vi.fn(),
      },
      storage: new MemoryStorage(),
      paginateAnswer: (answer) => [answer],
      onState: () => undefined,
      createIdempotencyKey: () => 'key-live',
    });
    const recorder = new G2Recorder({
      bridge: {
        async audioControl(open) {
          if (open) await openPending;
          return true;
        },
      },
      controller,
      audioSource: AudioInputSource.Glasses,
      scheduleStop: () => 1,
      cancelStop: () => undefined,
    });
    await controller.boot();

    const starting = recorder.start();
    expect(startLiveTurn).toHaveBeenCalledWith(
      'token',
      'key-live',
      expect.any(Function),
    );
    releaseOpen();
    await starting;
    const chunk = new Uint8Array([1, 2, 3, 4]);
    recorder.pushPcm(chunk);

    expect(push).toHaveBeenCalledWith(chunk);
    await recorder.cancel();
  });

  it('freezes PCM and leaves recording before slow microphone close completes', async () => {
    let releaseClose!: () => void;
    const closePending = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const submitTurn = vi.fn<EvenHubApiPort['submitTurn']>(
      async (_token, _pcm, _durationMs) => ({
        turnId: 'turn-1',
        state: 'completed',
        transcript: 'fixture',
        answer: 'answer',
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:01.000Z',
        completedAt: '2026-07-17T00:00:01.000Z',
        pollAfterMs: 500,
      }),
    );
    const controller = new TurnController({
      api: {
        checkReady: vi.fn(async () => undefined),
        pair: vi.fn(),
        submitTurn,
        getTurn: vi.fn(),
      },
      storage: new MemoryStorage(),
      paginateAnswer: (answer) => [answer],
      onState: () => undefined,
    });
    const bridge = {
      audioControl: vi.fn(async (open: boolean) => {
        if (open) return true;
        await closePending;
        return true;
      }),
    };
    const recorder = new G2Recorder({
      bridge,
      controller,
      audioSource: AudioInputSource.Glasses,
      scheduleStop: () => 1,
      cancelStop: () => undefined,
    });

    await controller.boot();
    await recorder.start();
    recorder.pushPcm(new Uint8Array(32_000));

    const finishing = recorder.finish();
    expect(controller.state.kind).toBe('stopping');

    recorder.pushPcm(new Uint8Array(32_000));
    releaseClose();
    await finishing;

    expect(submitTurn).toHaveBeenCalledOnce();
    expect(submitTurn.mock.calls[0][1]).toHaveLength(32_000);
    expect(submitTurn.mock.calls[0][2]).toBe(1_000);
  });

  it('leaves recording immediately even when the captured audio is too short', async () => {
    let releaseClose!: () => void;
    const closePending = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const states: string[] = [];
    const abort = vi.fn();
    const controller = new TurnController({
      api: {
        checkReady: vi.fn(async () => undefined),
        pair: vi.fn(),
        submitTurn: vi.fn(),
        startLiveTurn: () => ({ push: vi.fn(), finish: vi.fn(), abort }),
        getTurn: vi.fn(),
      },
      storage: new MemoryStorage(),
      paginateAnswer: (answer) => [answer],
      onState: (state) => states.push(state.kind),
    });
    const recorder = new G2Recorder({
      bridge: {
        async audioControl(open) {
          if (!open) await closePending;
          return true;
        },
      },
      controller,
      audioSource: AudioInputSource.Glasses,
      scheduleStop: () => 1,
      cancelStop: () => undefined,
    });

    await controller.boot();
    await recorder.start();
    recorder.pushPcm(new Uint8Array(3_200));

    const finishing = recorder.finish();
    expect(controller.state.kind).toBe('stopping');
    releaseClose();
    await finishing;

    expect(controller.state).toMatchObject({
      kind: 'error',
      retryable: false,
    });
    expect(states).toContain('stopping');
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe('routeHubInteraction', () => {
  it('treats a captured text-container click as the primary tap', () => {
    expect(routeHubInteraction({ textEvent: { eventType: 0 } })).toBe(
      'primary',
    );
  });

  it.each([{ sysEvent: {} }, { textEvent: {} }])(
    'treats an omitted protobuf default event type as a click: %j',
    (event) => {
      expect(routeHubInteraction(event)).toBe('primary');
    },
  );
});
