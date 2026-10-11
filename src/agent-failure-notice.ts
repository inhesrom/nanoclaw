import type { Channel } from './types.js';
import { formatAgentFailureNotice } from './group-queue.js';
import { queueWhatsAppOutbound } from './whatsapp-outbox.js';

/** The host sends this even when no agent container or WhatsApp session is active. */
export async function sendAgentFailureNotice(
  chatJid: string,
  error: string | undefined,
  channel: Pick<Channel, 'sendMessage'> | undefined,
): Promise<void> {
  const notice = formatAgentFailureNotice(error);
  if (channel) {
    await channel.sendMessage(chatJid, notice);
  } else if (chatJid.endsWith('@s.whatsapp.net') || chatJid.endsWith('@g.us')) {
    queueWhatsAppOutbound(chatJid, notice);
  } else {
    throw new Error(
      `No channel available to send failure notice to ${chatJid}`,
    );
  }
}
