import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getPendingWhatsAppOutbox } from './db.js';
import { sendAgentFailureNotice } from './agent-failure-notice.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('agent failure notice', () => {
  it('saves a WhatsApp notice when the channel is unavailable', async () => {
    await sendAgentFailureNotice(
      '123@s.whatsapp.net',
      'free Grok Build usage limit: private diagnostic',
      undefined,
    );

    const [notice] = getPendingWhatsAppOutbox();
    expect(notice.chat_jid).toBe('123@s.whatsapp.net');
    expect(notice.text).toContain(
      'The AI service has reached its usage limit.',
    );
    expect(notice.text).not.toContain('private diagnostic');
  });

  it('uses the connected channel for a failure notice', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    await sendAgentFailureNotice('123@s.whatsapp.net', 'Timed Out', {
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      '123@s.whatsapp.net',
      expect.stringContaining('The agent timed out.'),
    );
    expect(getPendingWhatsAppOutbox()).toEqual([]);
  });
});
