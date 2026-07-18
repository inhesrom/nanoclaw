import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildPrivateClient,
  evenhubRoot,
  packPrivateManifest,
  readPrivateOrigin,
  renderPrivateManifest,
} from './private-package.mjs';

const workspace = mkdtempSync(path.join(tmpdir(), 'nanoclaw-evenhub-private-'));

try {
  const origin = readPrivateOrigin();
  const manifest = path.join(workspace, 'app.json');
  const output = path.join(evenhubRoot, 'nanoclaw-evenhub-0.4.0.ehpk');
  renderPrivateManifest(origin, manifest);
  buildPrivateClient(origin);
  packPrivateManifest(manifest, output);
  const digest = createHash('sha256')
    .update(readFileSync(output))
    .digest('hex');
  process.stdout.write(`Private package SHA-256: ${digest}\n`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
