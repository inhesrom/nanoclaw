import { describe, expect, it } from 'vitest';

import {
  conversationEntries,
  initialState,
  reduceAppState,
} from '../src/state';

describe('EvenHub app reducer', () => {
  it('opens final draft review on Send before entering thinking', () => {
    const capable = reduceAppState(initialState, {
      type: 'CAPABILITIES_UPDATED',
      capabilities: { voice: true, text: true },
    });
    const ready = reduceAppState(capable, {
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
    const uploading = reduceAppState(stopping, {
      type: 'UPLOAD_STARTED',
      idempotencyKey: 'key',
    });
    const active = { id: 'turn-1', idempotencyKey: 'key' };
    const transcribing = reduceAppState(uploading, {
      type: 'TURN_ACCEPTED',
      turn: active,
    });
    const review = reduceAppState(transcribing, {
      type: 'TURN_UPDATED',
      turn: active,
      result: serverTurn('awaiting_confirmation'),
    });

    expect(review).toMatchObject({
      kind: 'review',
      transcript: 'hello',
      choiceOpen: true,
      choice: 'send',
    });
    const toggled = reduceAppState(review, { type: 'CONFIRMATION_TOGGLE' });
    expect(toggled).toMatchObject({
      kind: 'review',
      choiceOpen: true,
      choice: 'discard',
    });

    const closed = reduceAppState(toggled, { type: 'CONFIRMATION_CLOSE' });
    expect(closed).toMatchObject({ kind: 'review', choiceOpen: false });
    expect(reduceAppState(closed, { type: 'CONFIRMATION_OPEN' })).toMatchObject(
      { kind: 'review', choiceOpen: true, choice: 'send' },
    );

    const thinking = reduceAppState(review, {
      type: 'TURN_UPDATED',
      turn: active,
      result: serverTurn('dispatching'),
    });
    expect(thinking.kind).toBe('thinking');
  });

  it('restores only the durable unresolved turn', () => {
    expect(
      reduceAppState(initialState, {
        type: 'RESTORED',
        hasToken: true,
        activeTurn: { id: 'turn-1', idempotencyKey: 'key' },
      }),
    ).toMatchObject({
      kind: 'transcribing',
      turn: { id: 'turn-1', idempotencyKey: 'key' },
      session: { turns: [] },
    });
  });

  it('carries live transcript snapshots through immediate stop feedback', () => {
    const capable = reduceAppState(initialState, {
      type: 'CAPABILITIES_UPDATED',
      capabilities: { voice: true, text: true },
    });
    const ready = reduceAppState(capable, {
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

    const stopping = reduceAppState(snapshot, {
      type: 'RECORD_STOP_REQUESTED',
    });
    expect(stopping).toMatchObject({
      kind: 'stopping',
      finalText: 'book the',
      interimText: 'window seat',
    });
    expect(conversationEntries(stopping).at(-1)).toMatchObject({
      speaker: 'You',
      text: 'book the window seat',
    });
  });

  it('keeps completed and failed turns in one chronological session feed', () => {
    const first = reduceAppState(initialState, {
      type: 'TURN_COMPLETED',
      turnId: 'turn-1',
      transcript: 'first prompt',
      reply: 'first reply',
    });
    const second = reduceAppState(first, {
      type: 'TURN_FAILED',
      turnId: 'turn-2',
      transcript: 'second prompt',
      message: 'Agent failed safely.',
    });

    expect(second.kind).toBe('ready');
    expect(second.session.turns).toHaveLength(2);
    expect(conversationEntries(second)).toEqual([
      { id: 'turn-1:you', speaker: 'You', text: 'first prompt' },
      { id: 'turn-1:reply', speaker: 'NanoClaw', text: 'first reply' },
      { id: 'turn-2:you', speaker: 'You', text: 'second prompt' },
      { id: 'turn-2:failure', speaker: 'Notice', text: 'Agent failed safely.' },
    ]);
  });

  it('marks manual scrolling without losing the feed', () => {
    const completed = reduceAppState(initialState, {
      type: 'TURN_COMPLETED',
      turnId: 'turn-1',
      transcript: 'prompt',
      reply: 'reply',
    });
    expect(
      reduceAppState(completed, { type: 'SCROLLED', offset: 4 }),
    ).toMatchObject({
      session: { scrollOffset: 4, manuallyScrolled: true },
    });
  });

  it('shows a typed prompt during submission and bypasses voice review', () => {
    const capable = reduceAppState(initialState, {
      type: 'CAPABILITIES_UPDATED',
      capabilities: { voice: false, text: true },
    });
    const ready = reduceAppState(capable, {
      type: 'RESTORED',
      hasToken: true,
    });
    const submitting = reduceAppState(ready, {
      type: 'TEXT_SUBMIT_STARTED',
      idempotencyKey: 'key-text',
      text: 'first line\nsecond line',
    });
    expect(submitting.kind).toBe('submitting_text');
    expect(conversationEntries(submitting).at(-1)).toMatchObject({
      speaker: 'You',
      text: 'first line\nsecond line',
    });

    const acknowledged = reduceAppState(submitting, {
      type: 'TEXT_ACCEPTED',
      turn: { id: 'turn-text', idempotencyKey: 'key-text' },
      result: {
        turnId: 'turn-text',
        state: 'dispatching',
        transcript: 'first line\nsecond line',
        createdAt: 'now',
        updatedAt: 'now',
        pollAfterMs: 500,
      },
    });
    expect(acknowledged).toMatchObject({
      kind: 'thinking',
      transcript: 'first line\nsecond line',
    });
  });
});

function serverTurn(state: 'awaiting_confirmation' | 'dispatching') {
  return {
    turnId: 'turn-1',
    state,
    transcript: 'hello',
    createdAt: 'now',
    updatedAt: 'now',
    pollAfterMs: 500,
  } as const;
}
