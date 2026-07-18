import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAndValidateManifest } from './benchmark-corpus.js';
import { createBenchmarkFixture } from './benchmark-test-fixtures.js';

describe('EvenHub benchmark corpus', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-corpus-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('validates count, distributions, PCM, references, metadata, and hashes', () => {
    const fixture = createBenchmarkFixture(root);
    const validated = loadAndValidateManifest(
      fixture.manifestPath,
      fixture.projectRoot,
    );
    expect(validated.samples).toHaveLength(30);
    expect(validated.corpusSha256).toBe(fixture.manifest.corpusSha256);
  });

  it('rejects malformed PCM and distribution drift', () => {
    const fixture = createBenchmarkFixture(root);
    fs.appendFileSync(fixture.manifest.samples[0].pcmPath, Buffer.from([1]));
    expect(() =>
      loadAndValidateManifest(fixture.manifestPath, fixture.projectRoot),
    ).toThrow(/signed 16-bit|checksum/);

    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root);
    const second = createBenchmarkFixture(root);
    second.manifest.samples[0].noise = 'free_choice';
    fs.writeFileSync(
      second.manifestPath,
      `${JSON.stringify(second.manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      loadAndValidateManifest(second.manifestPath, second.projectRoot),
    ).toThrow(/at least 3 quiet/);
  });

  it('rejects artifacts in git or readable by other users', () => {
    const fixture = createBenchmarkFixture(root);
    fs.chmodSync(fixture.manifestPath, 0o644);
    expect(() =>
      loadAndValidateManifest(fixture.manifestPath, fixture.projectRoot),
    ).toThrow(/owner-only/);

    const insidePath = path.join(fixture.projectRoot, 'manifest.json');
    fs.copyFileSync(fixture.manifestPath, insidePath);
    fs.chmodSync(insidePath, 0o600);
    expect(() =>
      loadAndValidateManifest(insidePath, fixture.projectRoot),
    ).toThrow(/outside/);
  });
});
