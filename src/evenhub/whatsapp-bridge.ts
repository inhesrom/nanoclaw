import { generateMessageID } from '@whiskeysockets/baileys';

import {
  getEvenTurnsByStates,
  getNextEvenTurnToDispatch,
  hasStoredEvenTurnPrompt,
  markEvenTurnQueuedAfterPrompt,
  reserveEvenTurnWhatsAppMessage,
  storeChatMetadata,
  storeMessageDirect,
  transitionEvenTurnState,
} from '../db.js';
import { logger as defaultLogger } from '../logger.js';
import type { Channel } from '../types.js';
import type { EvenTurn } from './types.js';

export interface EvenHubWhatsAppTarget {
  jid: string;
  channel: Channel;
}

interface BridgeLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

export interface EvenHubWhatsAppBridgeOptions {
  getTarget: () => EvenHubWhatsAppTarget | undefined;
  createMessageId?: () => string;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  availabilityWindowMs?: number;
  availabilityPollMs?: number;
  logger?: BridgeLogger;
}

const defaultDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class EvenHubWhatsAppBridge {
  private readonly createMessageId: () => string;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly availabilityWindowMs: number;
  private readonly availabilityPollMs: number;
  private readonly logger: BridgeLogger;
  private running = false;
  private requested = false;
  private stopping = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: EvenHubWhatsAppBridgeOptions) {
    this.createMessageId = options.createMessageId ?? generateMessageID;
    this.delay = options.delay ?? defaultDelay;
    this.now = options.now ?? (() => new Date());
    this.availabilityWindowMs = options.availabilityWindowMs ?? 30_000;
    this.availabilityPollMs = options.availabilityPollMs ?? 1_000;
    this.logger = options.logger ?? defaultLogger;
  }

  start(): void {
    this.reconcile();
    this.requestDispatch();
  }

  requestDispatch(): void {
    if (this.stopping) return;
    this.requested = true;
    if (this.running) return;
    this.running = true;
    void this.drain().catch((error) => {
      this.logger.error(
        { error_type: error instanceof Error ? error.name : 'UnknownError' },
        'whatsapp.dispatch_worker_failed',
      );
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.waitForIdle();
  }

  waitForIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private reconcile(): void {
    for (const turn of getEvenTurnsByStates(['dispatching'])) {
      if (!turn.whatsapp_message_id) continue;
      if (
        hasStoredEvenTurnPrompt(turn.id, turn.whatsapp_message_id) &&
        markEvenTurnQueuedAfterPrompt(turn.id, turn.whatsapp_message_id)
      ) {
        this.logger.info(
          { turn_id: turn.id, state: 'queued' },
          'whatsapp.prompt_recovered',
        );
      } else {
        this.failClosed(
          turn,
          'whatsapp_unavailable',
          'Prompt delivery was interrupted; the turn was not resent.',
        );
      }
    }

    for (const turn of getEvenTurnsByStates(['queued'])) {
      if (
        turn.whatsapp_message_id &&
        hasStoredEvenTurnPrompt(turn.id, turn.whatsapp_message_id)
      ) {
        continue;
      }
      this.failClosed(
        turn,
        'whatsapp_unavailable',
        'The stored WhatsApp prompt is unavailable.',
      );
    }

    for (const turn of getEvenTurnsByStates(['running'])) {
      this.failClosed(
        turn,
        'agent_failed',
        'Agent delivery was interrupted; the turn was not replayed.',
      );
    }
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.requested = false;
        const turn = getNextEvenTurnToDispatch();
        if (turn) await this.dispatch(turn);
      } while (!this.stopping && this.requested);
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private async dispatch(turn: EvenTurn): Promise<void> {
    if (!turn.transcript) {
      this.failClosed(
        turn,
        'whatsapp_unavailable',
        'The transcribed prompt is unavailable.',
      );
      return;
    }

    const deadline = this.now().getTime() + this.availabilityWindowMs;
    let target = this.options.getTarget();
    while (
      !this.stopping &&
      (!target?.channel.isConnected() || !target.channel.sendSelfMessage) &&
      this.now().getTime() < deadline
    ) {
      await this.delay(this.availabilityPollMs);
      target = this.options.getTarget();
    }
    if (
      this.stopping ||
      !target?.channel.isConnected() ||
      !target.channel.sendSelfMessage
    ) {
      if (!this.stopping) {
        this.failClosed(
          turn,
          'whatsapp_unavailable',
          'WhatsApp was unavailable for this turn.',
        );
      }
      return;
    }

    const messageId = this.createMessageId();
    if (!reserveEvenTurnWhatsAppMessage(turn.id, messageId)) return;

    let delivered: { id: string; timestamp: string };
    try {
      delivered = await target.channel.sendSelfMessage(
        target.jid,
        turn.transcript,
        messageId,
      );
    } catch {
      const reserved = { ...turn, whatsapp_message_id: messageId };
      this.failClosed(
        reserved,
        'whatsapp_unavailable',
        'Prompt delivery could not be confirmed; the turn was not resent.',
      );
      return;
    }

    storeChatMetadata(
      target.jid,
      delivered.timestamp,
      'NanoClaw self-chat',
      'whatsapp',
      false,
    );
    storeMessageDirect({
      id: delivered.id,
      chat_jid: target.jid,
      sender: target.jid,
      sender_name: 'Even G2',
      content: turn.transcript,
      timestamp: delivered.timestamp,
      is_from_me: true,
      is_bot_message: false,
      even_turn_id: turn.id,
    });
    if (!markEvenTurnQueuedAfterPrompt(turn.id, messageId)) return;
    this.logger.info(
      {
        turn_id: turn.id,
        state: 'queued',
        message_id: messageId,
        prompt_length: turn.transcript.length,
      },
      'whatsapp.prompt_sent',
    );
  }

  private failClosed(
    turn: EvenTurn,
    code: 'whatsapp_unavailable' | 'agent_failed',
    message: string,
  ): void {
    const failed = transitionEvenTurnState(turn.id, turn.state, 'failed', {
      errorCode: code,
      errorMessage: message,
      completedAt: this.now().toISOString(),
    });
    if (!failed) return;
    this.logger.warn(
      { turn_id: turn.id, state: 'failed', error_code: code },
      'even.turn.failed',
    );
  }
}
