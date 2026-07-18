import { createHash, randomInt } from 'crypto';

import { replaceEvenPairingCode } from '../db.js';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createEvenPairingCode(
  ttlMs = 5 * 60 * 1000,
  now = new Date(),
): { code: string; expiresAt: string } {
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  replaceEvenPairingCode({
    code_sha256: sha256(code),
    created_at: now.toISOString(),
    expires_at: expiresAt,
    consumed_at: null,
  });
  return { code, expiresAt };
}
