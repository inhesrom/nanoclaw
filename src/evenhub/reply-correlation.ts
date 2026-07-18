import type { NewMessage } from '../types.js';

export type ActiveContainerDelivery = 'pipe' | 'pipe-when-idle' | 'queue';

/**
 * Preserve the one-input/one-reply boundary around durable EvenHub turns.
 * Ordinary follow-ups retain the existing active-container behavior.
 */
export function getActiveContainerDelivery(
  messages: NewMessage[],
  hasRunningEvenTurn: boolean,
): ActiveContainerDelivery {
  if (hasRunningEvenTurn) return 'queue';
  if (messages.some((message) => Boolean(message.even_turn_id))) {
    return 'pipe-when-idle';
  }
  return 'pipe';
}
