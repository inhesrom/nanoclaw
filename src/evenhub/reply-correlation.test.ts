import { describe, expect, it } from 'vitest';

import type { NewMessage } from '../types.js';
import { getActiveContainerDelivery } from './reply-correlation.js';

function message(evenTurnId?: string): NewMessage {
  return {
    id: evenTurnId ?? 'ordinary-message',
    chat_jid: '123@s.whatsapp.net',
    sender: '123@s.whatsapp.net',
    sender_name: 'Ian',
    content: evenTurnId ? 'EvenHub prompt' : 'ordinary prompt',
    timestamp: '2026-07-17T12:00:00.000Z',
    even_turn_id: evenTurnId,
  };
}

describe('EvenHub reply correlation', () => {
  it('allows ordinary follow-ups to use the existing active-container path', () => {
    expect(getActiveContainerDelivery([message()], false)).toBe('pipe');
  });

  it('only pipes a new EvenHub prompt after the previous reply is complete', () => {
    expect(getActiveContainerDelivery([message('turn-1')], false)).toBe(
      'pipe-when-idle',
    );
  });

  it('queues every later input while an EvenHub reply is in flight', () => {
    expect(getActiveContainerDelivery([message()], true)).toBe('queue');
    expect(getActiveContainerDelivery([message('turn-2')], true)).toBe('queue');
  });
});
