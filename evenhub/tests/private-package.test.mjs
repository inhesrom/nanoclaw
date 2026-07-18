import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPrivatePackages,
  readPrivateOrigin,
  renderPrivateManifest,
  validateTailnetOrigin,
} from '../scripts/private-package.mjs';

const workspaces = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function workspace() {
  const directory = mkdtempSync(path.join(tmpdir(), 'evenhub-private-test-'));
  workspaces.push(directory);
  return directory;
}

describe('private EvenHub package configuration', () => {
  it('runs an independent client build for each reproducibility artifact', () => {
    const events = [];
    buildPrivatePackages(
      'https://nanoclaw.example.ts.net',
      '/tmp/app.json',
      ['/tmp/first.ehpk', '/tmp/second.ehpk'],
      {
        buildClient: (origin) => events.push(['build', origin]),
        packManifest: (manifest, output) =>
          events.push(['pack', manifest, output]),
      },
    );

    expect(events).toEqual([
      ['build', 'https://nanoclaw.example.ts.net'],
      ['pack', '/tmp/app.json', '/tmp/first.ehpk'],
      ['build', 'https://nanoclaw.example.ts.net'],
      ['pack', '/tmp/app.json', '/tmp/second.ehpk'],
    ]);
  });

  it('accepts only canonical HTTPS tailnet origins', () => {
    expect(validateTailnetOrigin('https://nanoclaw.example.ts.net')).toBe(
      'https://nanoclaw.example.ts.net',
    );
    for (const value of [
      'http://nanoclaw.example.ts.net',
      'https://nanoclaw.example.ts.net/',
      'https://nanoclaw.example.ts.net:8443',
      'https://example.ts.net',
      'https://nanoclaw.local',
    ]) {
      expect(() => validateTailnetOrigin(value)).toThrow(
        'canonical HTTPS ts.net origin',
      );
    }
  });

  it('requires an owner-only local origin file', () => {
    const directory = workspace();
    const privateEnv = path.join(directory, '.env.private');
    writeFileSync(
      privateEnv,
      'EVENHUB_ORIGIN=https://nanoclaw.example.ts.net\n',
      { mode: 0o600 },
    );
    expect(readPrivateOrigin(privateEnv)).toBe(
      'https://nanoclaw.example.ts.net',
    );

    chmodSync(privateEnv, 0o644);
    expect(() => readPrivateOrigin(privateEnv)).toThrow(
      'must not be accessible by group or other users',
    );
  });

  it('renders one exact HTTPS/WSS whitelist without changing package identity', () => {
    const directory = workspace();
    const manifestPath = path.join(directory, 'app.private.json');
    const manifest = renderPrivateManifest(
      'https://nanoclaw.example.ts.net',
      manifestPath,
    );
    const network = manifest.permissions.find(({ name }) => name === 'network');

    expect(manifest.package_id).toBe('dev.inhesrom.nanoclaw.evenhub');
    expect(network.whitelist).toEqual([
      'https://nanoclaw.example.ts.net',
      'wss://nanoclaw.example.ts.net',
    ]);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(manifest);
  });
});
