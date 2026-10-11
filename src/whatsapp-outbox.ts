import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME } from './config.js';
import { enqueueWhatsAppOutbox } from './db.js';

export function formatWhatsAppOutbound(text: string): string {
  return ASSISTANT_HAS_OWN_NUMBER ? text : `${ASSISTANT_NAME}: ${text}`;
}

export function queueWhatsAppOutbound(chatJid: string, text: string): string {
  return enqueueWhatsAppOutbox(chatJid, formatWhatsAppOutbound(text));
}
