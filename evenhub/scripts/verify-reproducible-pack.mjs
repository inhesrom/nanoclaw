import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildPrivateClient,
  packPrivateManifest,
  readPrivateOrigin,
  renderPrivateManifest,
} from './private-package.mjs';

const workspace = mkdtempSync(path.join(tmpdir(), 'nanoclaw-evenhub-pack-'));

function digest(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

try {
  const origin = readPrivateOrigin();
  const manifest = path.join(workspace, 'app.json');
  const first = path.join(workspace, 'first.ehpk');
  const second = path.join(workspace, 'second.ehpk');
  renderPrivateManifest(origin, manifest);
  buildPrivateClient(origin);
  for (const output of [first, second]) {
    packPrivateManifest(manifest, output);
  }

  const firstDigest = digest(first);
  const secondDigest = digest(second);
  if (firstDigest !== secondDigest) {
    throw new Error(
      `EvenHub packages are not reproducible: ${firstDigest} != ${secondDigest}`,
    );
  }
  process.stdout.write(
    `Reproducible private package SHA-256: ${firstDigest}\n`,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
