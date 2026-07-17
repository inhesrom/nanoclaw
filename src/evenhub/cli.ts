import { EVENHUB_PAIRING_TTL_MS } from '../config.js';
import { initDatabase, revokeAllEvenDevices } from '../db.js';
import { createEvenPairingCode } from './pairing.js';

function usage(): never {
  console.error('Usage: npm run evenhub:pair | npm run evenhub:revoke');
  process.exit(1);
}

function main(): void {
  initDatabase();
  const command = process.argv[2];
  if (command === 'pair') {
    const pairing = createEvenPairingCode(EVENHUB_PAIRING_TTL_MS);
    console.log(`EvenHub pairing code: ${pairing.code}`);
    console.log(`Expires at: ${pairing.expiresAt}`);
    return;
  }
  if (command === 'revoke') {
    const count = revokeAllEvenDevices(new Date().toISOString());
    console.log(`Revoked ${count} EvenHub device token(s).`);
    return;
  }
  usage();
}

main();
