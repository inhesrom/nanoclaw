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
    const stopping = reduceAppState(recording, {
      type: 'RECORD_STOP_REQUESTED',
    });
    expect(stopping).toEqual({
      kind: 'stopping',
      session: { turns: [], turn: 0 },
    });
    const uploading = reduceAppState(stopping, {
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
        turnId: 'turn-1',
        state: 'running',
        transcript: 'hello',
        createdAt: 'now',
        updatedAt: 'now',
        pollAfterMs: 500,
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
      session: { turns: [], turn: 0 },
    });
  });

  it('carries complete transcript snapshots through immediate stop feedback', () => {
    const ready = reduceAppState(initialState, {
      type: 'RESTORED',
      hasToken: true,
    });
    const recording = reduceAppState(ready, {
      type: 'RECORD_STARTED',
      startedAt: 10,
    });
    const snapshot = reduceAppState(recording, {
      type: 'TRANSCRIPT_SNAPSHOT',
      finalText: 'book the',
      interimText: 'window seat',
    });

    expect(
      reduceAppState(snapshot, { type: 'RECORD_STOP_REQUESTED' }),
    ).toMatchObject({
      kind: 'stopping',
      finalText: 'book the',
      interimText: 'window seat',
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

  it('keeps completed turns in session and pages across turn boundaries', () => {
    const first = reduceAppState(initialState, {
      type: 'TURN_COMPLETED',
      turnId: 'turn-1',
      transcript: 'first prompt',
      pages: ['first a', 'first b'],
    });
    const ready = reduceAppState(first, { type: 'READY' });
    const second = reduceAppState(ready, {
      type: 'TURN_COMPLETED',
      turnId: 'turn-2',
      transcript: 'second prompt',
      pages: ['second'],
    });

    expect(second.session.turns).toHaveLength(2);
    expect(second).toMatchObject({
      kind: 'answer',
      turnId: 'turn-2',
      page: 0,
      session: { turn: 1 },
    });

    const previousTurn = reduceAppState(second, { type: 'PAGE_PREVIOUS' });
    expect(previousTurn).toMatchObject({
      kind: 'answer',
      turnId: 'turn-1',
      page: 1,
      session: { turn: 0 },
    });

    const nextTurn = reduceAppState(previousTurn, { type: 'PAGE_NEXT' });
    expect(nextTurn).toMatchObject({
      kind: 'answer',
      turnId: 'turn-2',
      page: 0,
      session: { turn: 1 },
    });
  });
});
