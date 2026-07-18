import { createHash } from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  activateEvenDeviceFromPairingCode,
  getEvenTurnById,
  insertEvenTurn,
  replaceEvenPairingCode,
  transitionEvenTurnState,
} from '../db.js';
import type { Channel } from '../types.js';
import { toPublicEvenTurn } from './types.js';
import {
  deliverEvenHubReply,
  EvenHubReplyDeliveryError,
} from './reply-delivery.js';

const silentLogger = { info: vi.fn(), warn: vi.fn() };

describe('deliverEvenHubReply', () => {
  beforeEach(() => {
    _initTestDatabase();
    const now = '2026-07-16T00:00:00.000Z';
    const pairingHash = 'a'.repeat(64);
    replaceEvenPairingCode({
      code_sha256: pairingHash,
      created_at: now,
      expires_at: '2026-07-16T00:05:00.000Z',
      consumed_at: null,
    });
    activateEvenDeviceFromPairingCode(
      pairingHash,
      {
        id: 'device-1',
        name: 'test device',
        token_sha256: 'b'.repeat(64),
        created_at: now,
        last_used_at: now,
        revoked_at: null,
      },
      now,
    );
    insertEvenTurn({
      id: 'turn-1',
      device_id: 'device-1',
      idempotency_key: 'key-1',
      request_sha256: createHash('sha256').update('audio').digest('hex'),
      audio_path: '/tmp/turn-1.pcm',
      audio_duration_ms: 250,
      state: 'running',
      created_at: now,
      updated_at: now,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    _closeDatabase();
  });

  function channel(
    sendMessageConfirmed: Channel['sendMessageConfirmed'],
  ): Channel {
    return {
      name: 'whatsapp',
      connect: async () => undefined,
      sendMessage: async () => undefined,
      sendMessageConfirmed,
      isConnected: () => true,
      ownsJid: () => true,
      disconnect: async () => undefined,
    };
  }

  it('persists the exact Unicode answer only after confirmed delivery', async () => {
    const answer = 'Exact café answer 👓 — unchanged';
    const sendMessageConfirmed = vi.fn(async () => {
      expect(getEvenTurnById('turn-1')).toMatchObject({
        state: 'running',
        answer: null,
      });
      return { id: 'reply-id', timestamp: '2026-07-16T00:00:01.000Z' };
    });

    await deliverEvenHubReply(
      'turn-1',
      '123@s.whatsapp.net',
      channel(sendMessageConfirmed),
      answer,
      {
        now: () => new Date('2026-07-16T00:00:02.000Z'),
        logger: silentLogger,
      },
    );

    expect(sendMessageConfirmed).toHaveBeenCalledWith(
      '123@s.whatsapp.net',
      answer,
    );
    const completed = getEvenTurnById('turn-1')!;
    expect(completed).toMatchObject({
      state: 'completed',
      answer,
      completed_at: '2026-07-16T00:00:02.000Z',
    });
    expect(toPublicEvenTurn(completed).answer).toBe(answer);
    expect(
      transitionEvenTurnState('turn-1', 'completed', 'completed', {
        answer: 'changed',
      }),
    ).toBe(false);
    expect(getEvenTurnById('turn-1')?.answer).toBe(answer);
    expect(JSON.stringify(silentLogger.info.mock.calls)).not.toContain(answer);
  });

  it('fails closed without an answer when delivery is unconfirmed', async () => {
    const sendMessageConfirmed = vi.fn(async () => {
      throw new Error('connection lost');
    });

    await expect(
      deliverEvenHubReply(
        'turn-1',
        '123@s.whatsapp.net',
        channel(sendMessageConfirmed),
        'must not persist',
        { logger: silentLogger },
      ),
    ).rejects.toBeInstanceOf(EvenHubReplyDeliveryError);
    expect(sendMessageConfirmed).toHaveBeenCalledOnce();
    expect(getEvenTurnById('turn-1')).toMatchObject({
      state: 'failed',
      answer: null,
      error_code: 'whatsapp_unavailable',
    });
  });

  it('never sends when the turn is already terminal', async () => {
    transitionEvenTurnState('turn-1', 'running', 'failed', {
      errorCode: 'agent_failed',
      errorMessage: 'failed',
      completedAt: new Date().toISOString(),
    });
    const sendMessageConfirmed = vi.fn();

    await expect(
      deliverEvenHubReply(
        'turn-1',
        '123@s.whatsapp.net',
        channel(sendMessageConfirmed),
        'duplicate',
      ),
    ).rejects.toBeInstanceOf(EvenHubReplyDeliveryError);
    expect(sendMessageConfirmed).not.toHaveBeenCalled();
  });

  it('does not resend when completion persistence loses its compare-and-set', async () => {
    const sendMessageConfirmed = vi.fn(async () => {
      transitionEvenTurnState('turn-1', 'running', 'failed', {
        errorCode: 'agent_failed',
        errorMessage: 'concurrent terminal state',
        completedAt: new Date().toISOString(),
      });
      return { id: 'reply-id', timestamp: '2026-07-16T00:00:01.000Z' };
    });

    await expect(
      deliverEvenHubReply(
        'turn-1',
        '123@s.whatsapp.net',
        channel(sendMessageConfirmed),
        'delivered once',
        { logger: silentLogger },
      ),
    ).rejects.toBeInstanceOf(EvenHubReplyDeliveryError);

    expect(sendMessageConfirmed).toHaveBeenCalledOnce();
    expect(getEvenTurnById('turn-1')).toMatchObject({
      state: 'failed',
      answer: null,
    });
  });
});
