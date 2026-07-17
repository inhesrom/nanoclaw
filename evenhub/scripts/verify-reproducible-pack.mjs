import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workspace = mkdtempSync(path.join(tmpdir(), 'nanoclaw-evenhub-pack-'));
const cli = path.resolve('node_modules/.bin/evenhub');

function digest(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

try {
  const first = path.join(workspace, 'first.ehpk');
  const second = path.join(workspace, 'second.ehpk');
  for (const output of [first, second]) {
    execFileSync(cli, ['pack', '-o', output, 'app.json', 'dist'], {
      stdio: 'inherit',
    });
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
