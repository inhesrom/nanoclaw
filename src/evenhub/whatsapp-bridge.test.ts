import { createHash } from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  activateEvenDeviceFromPairingCode,
  getEvenTurnById,
  getMessagesSince,
  insertEvenTurn,
  reserveEvenTurnWhatsAppMessage,
  replaceEvenPairingCode,
  storeChatMetadata,
  storeMessageDirect,
  transitionEvenTurnState,
} from '../db.js';
import type { Channel } from '../types.js';
import {
  EvenHubWhatsAppBridge,
  type EvenHubWhatsAppTarget,
} from './whatsapp-bridge.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('EvenHubWhatsAppBridge', () => {
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    _closeDatabase();
  });

  function dispatchingTurn(id: string, sequence = 0): void {
    const timestamp = new Date(
      Date.UTC(2026, 6, 16, 0, 0, sequence),
    ).toISOString();
    insertEvenTurn({
      id,
      device_id: 'device-1',
      idempotency_key: `key-${id}`,
      request_sha256: createHash('sha256').update(id).digest('hex'),
      audio_path: `/tmp/${id}.pcm`,
      audio_duration_ms: 250,
      state: 'accepted',
      created_at: timestamp,
      updated_at: timestamp,
    });
    transitionEvenTurnState(id, 'accepted', 'transcribing');
    transitionEvenTurnState(id, 'transcribing', 'dispatching', {
      transcript: `transcript for ${id}`,
    });
  }

  function target(
    overrides: Partial<Channel> = {},
  ): EvenHubWhatsAppTarget & { channel: Channel } {
    return {
      jid: '123@s.whatsapp.net',
      channel: {
        name: 'whatsapp',
        connect: async () => undefined,
        sendMessage: async () => undefined,
        sendSelfMessage: async (_jid, _text, messageId) => ({
          id: messageId,
          timestamp: '2026-07-16T00:00:01.000Z',
        }),
        isConnected: () => true,
        ownsJid: () => true,
        disconnect: async () => undefined,
        ...overrides,
      },
    };
  }

  it('persists a reserved Baileys ID before relaying and then queues the stored prompt', async () => {
    dispatchingTurn('turn-1');
    const sendSelfMessage = vi.fn(async (_jid, text, messageId) => {
      expect(text).toBe('transcript for turn-1');
      expect(getEvenTurnById('turn-1')).toMatchObject({
        state: 'dispatching',
        whatsapp_message_id: '3EB0RESERVED',
      });
      return {
        id: messageId,
        timestamp: '2026-07-16T00:00:01.000Z',
      };
    });
    const destination = target({ sendSelfMessage });
    const bridge = new EvenHubWhatsAppBridge({
      getTarget: () => destination,
      createMessageId: () => '3EB0RESERVED',
      logger: silentLogger,
    });

    bridge.start();
    await bridge.waitForIdle();

    expect(sendSelfMessage).toHaveBeenCalledOnce();
    expect(getEvenTurnById('turn-1')).toMatchObject({
      state: 'queued',
      whatsapp_message_id: '3EB0RESERVED',
    });
    expect(getMessagesSince('123@s.whatsapp.net', '', 'Andy')).toMatchObject([
      {
        id: '3EB0RESERVED',
        content: 'transcript for turn-1',
        even_turn_id: 'turn-1',
      },
    ]);
    expect(JSON.stringify(silentLogger.info.mock.calls)).not.toContain(
      'transcript for turn-1',
    );
  });

  it('recovers a locally stored prompt without relaying it again', async () => {
    dispatchingTurn('turn-stored');
    reserveEvenTurnWhatsAppMessage('turn-stored', '3EB0STORED');
    storeChatMetadata(
      '123@s.whatsapp.net',
      '2026-07-16T00:00:01.000Z',
      'NanoClaw self-chat',
      'whatsapp',
      false,
    );
    storeMessageDirect({
      id: '3EB0STORED',
      chat_jid: '123@s.whatsapp.net',
      sender: '123@s.whatsapp.net',
      sender_name: 'Even G2',
      content: 'transcript for turn-stored',
      timestamp: '2026-07-16T00:00:01.000Z',
      is_from_me: true,
      even_turn_id: 'turn-stored',
    });
    const sendSelfMessage = vi.fn();
    const bridge = new EvenHubWhatsAppBridge({
      getTarget: () => target({ sendSelfMessage }),
      logger: silentLogger,
    });

    bridge.start();
    await bridge.waitForIdle();

    expect(sendSelfMessage).not.toHaveBeenCalled();
    expect(getEvenTurnById('turn-stored')?.state).toBe('queued');
  });

  it('fails an ambiguous reserved relay closed on restart', async () => {
    dispatchingTurn('turn-ambiguous');
    reserveEvenTurnWhatsAppMessage('turn-ambiguous', '3EB0AMBIGUOUS');
    const sendSelfMessage = vi.fn();
    const bridge = new EvenHubWhatsAppBridge({
      getTarget: () => target({ sendSelfMessage }),
      logger: silentLogger,
    });

    bridge.start();
    await bridge.waitForIdle();

    expect(sendSelfMessage).not.toHaveBeenCalled();
    expect(getEvenTurnById('turn-ambiguous')).toMatchObject({
      state: 'failed',
      error_code: 'whatsapp_unavailable',
    });
  });

  it('does not resend after an unconfirmed relay attempt', async () => {
    dispatchingTurn('turn-relay-error');
    const sendSelfMessage = vi.fn(async () => {
      throw new Error('connection lost');
    });
    const destination = target({ sendSelfMessage });
    const bridge = new EvenHubWhatsAppBridge({
      getTarget: () => destination,
      createMessageId: () => '3EB0ONCE',
      logger: silentLogger,
    });

    bridge.start();
    await bridge.waitForIdle();
    bridge.requestDispatch();
    await bridge.waitForIdle();

    expect(sendSelfMessage).toHaveBeenCalledOnce();
    expect(getEvenTurnById('turn-relay-error')).toMatchObject({
      state: 'failed',
      whatsapp_message_id: '3EB0ONCE',
      error_code: 'whatsapp_unavailable',
    });
  });

  it('fails a running turn closed during restart reconciliation', async () => {
    dispatchingTurn('turn-running');
    transitionEvenTurnState('turn-running', 'dispatching', 'queued');
    transitionEvenTurnState('turn-running', 'queued', 'running');
    const bridge = new EvenHubWhatsAppBridge({
      getTarget: () => target(),
      logger: silentLogger,
    });

    bridge.start();
    await bridge.waitForIdle();

    expect(getEvenTurnById('turn-running')).toMatchObject({
      state: 'failed',
      error_code: 'agent_failed',
    });
  });

  it('waits for availability but never sends two active prompts', async () => {
    dispatchingTurn('turn-first', 0);
    dispatchingTurn('turn-second', 1);
    let connected = false;
    let currentTime = Date.parse('2026-07-16T00:00:00.000Z');
    const sendSelfMessage = vi.fn(async (_jid, _text, messageId) => ({
      id: messageId,
      timestamp: '2026-07-16T00:00:01.000Z',
    }));
    const destination = target({
      isConnected: () => connected,
      sendSelfMessage,
    });
    const bridge = new EvenHubWhatsAppBridge({
      getTarget: () => destination,
      createMessageId: () => '3EB0FIRST',
      now: () => new Date(currentTime),
      delay: async (milliseconds) => {
        currentTime += milliseconds;
        connected = true;
      },
      logger: silentLogger,
    });

    bridge.start();
    await bridge.waitForIdle();

    expect(sendSelfMessage).toHaveBeenCalledOnce();
    expect(getEvenTurnById('turn-first')?.state).toBe('queued');
    expect(getEvenTurnById('turn-second')?.state).toBe('dispatching');
  });
});
