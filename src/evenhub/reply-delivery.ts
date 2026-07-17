import { getEvenTurnById, transitionEvenTurnState } from '../db.js';
import { logger as defaultLogger } from '../logger.js';
import type { Channel } from '../types.js';

interface ReplyLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export class EvenHubReplyDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvenHubReplyDeliveryError';
  }
}

export async function deliverEvenHubReply(
  turnId: string,
  jid: string,
  channel: Channel,
  answer: string,
  options: { now?: () => Date; logger?: ReplyLogger } = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? defaultLogger;
  const turn = getEvenTurnById(turnId);
  if (!turn || turn.state !== 'running') {
    throw new EvenHubReplyDeliveryError('EvenHub turn is not running');
  }
  if (!channel.sendMessageConfirmed) {
    failReply(turnId, now(), 'WhatsApp cannot confirm reply delivery.');
    throw new EvenHubReplyDeliveryError(
      'WhatsApp cannot confirm reply delivery',
    );
  }

  try {
    await channel.sendMessageConfirmed(jid, answer);
  } catch {
    failReply(
      turnId,
      now(),
      'Reply delivery could not be confirmed; the turn was not replayed.',
    );
    throw new EvenHubReplyDeliveryError(
      'WhatsApp reply delivery was not confirmed',
    );
  }

  const completedAt = now().toISOString();
  const completed = transitionEvenTurnState(turnId, 'running', 'completed', {
    answer,
    completedAt,
  });
  if (!completed) {
    failReply(
      turnId,
      now(),
      'Reply delivery completed but durable completion was interrupted.',
    );
    logger.warn(
      { turn_id: turnId, state: 'delivery_ambiguous' },
      'even.turn.failed_closed',
    );
    throw new EvenHubReplyDeliveryError(
      'Reply was delivered but completion could not be persisted',
    );
  }
  logger.info(
    {
      turn_id: turnId,
      state: 'completed',
      answer_length: answer.length,
    },
    'whatsapp.reply_sent',
  );
  logger.info({ turn_id: turnId, state: 'completed' }, 'even.turn.completed');
}

function failReply(turnId: string, now: Date, message: string): void {
  transitionEvenTurnState(turnId, 'running', 'failed', {
    errorCode: 'whatsapp_unavailable',
    errorMessage: message,
    completedAt: now.toISOString(),
  });
}
