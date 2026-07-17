import { describe, expect, it } from 'vitest';

import { initialState, reduceAppState } from '../src/state';

describe('EvenHub app reducer', () => {
  it('follows the approved turn lifecycle', () => {
    const ready = reduceAppState(initialState, {
      type: 'RESTORED',
      hasToken: true,
    });
    const recording = reduceAppState(ready, {
      type: 'RECORD_STARTED',
      startedAt: 10,
    });
    const uploading = reduceAppState(recording, {
      type: 'UPLOAD_STARTED',
      idempotencyKey: 'key',
    });
    const active = { id: 'turn-1', idempotencyKey: 'key' };
    const transcribing = reduceAppState(uploading, {
      type: 'TURN_ACCEPTED',
      turn: active,
    });
    const thinking = reduceAppState(transcribing, {
      type: 'TURN_UPDATED',
      turn: active,
      result: {
        id: 'turn-1',
        state: 'running',
        transcript: 'hello',
        createdAt: 'now',
        updatedAt: 'now',
      },
    });
    const answer = reduceAppState(thinking, {
      type: 'TURN_COMPLETED',
      turnId: 'turn-1',
      transcript: 'hello',
      pages: ['one', 'two'],
    });
    expect(answer).toMatchObject({ kind: 'answer', page: 0 });
    expect(reduceAppState(answer, { type: 'PAGE_NEXT' })).toMatchObject({
      kind: 'answer',
      page: 1,
    });
  });

  it('restores a durable active turn directly into polling state', () => {
    expect(
      reduceAppState(initialState, {
        type: 'RESTORED',
        hasToken: true,
        activeTurn: { id: 'turn-1', idempotencyKey: 'key' },
      }),
    ).toEqual({
      kind: 'transcribing',
      turn: { id: 'turn-1', idempotencyKey: 'key' },
    });
  });

  it('ignores impossible recording transitions', () => {
    const pairing = reduceAppState(initialState, {
      type: 'RESTORED',
      hasToken: false,
    });
    expect(
      reduceAppState(pairing, { type: 'RECORD_STARTED', startedAt: 10 }),
    ).toBe(pairing);
  });
});
