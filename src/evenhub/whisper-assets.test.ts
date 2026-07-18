import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hashFile,
  verifyWhisperAssets,
  WHISPER_BASE_EN_SHA1,
  WHISPER_CPP_ARM64_SHA256,
  WHISPER_CPP_VERSION,
} from './whisper-assets.js';

describe('pinned Whisper assets', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('pins the selected release and model digests', () => {
    expect(WHISPER_CPP_VERSION).toBe('v1.9.1');
    expect(WHISPER_CPP_ARM64_SHA256).toBe(
      'e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3',
    );
    expect(WHISPER_BASE_EN_SHA1).toBe(
      '137c40403d78fd54d454da0f9bd998f78703390c',
    );
  });

  it('hashes files and rejects unpinned assets', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-assets-'));
    tempDirs.push(directory);
    const archive = path.join(directory, 'archive.tar.gz');
    const model = path.join(directory, 'ggml-base.en.bin');
    fs.writeFileSync(archive, 'archive');
    fs.writeFileSync(model, 'model');

    await expect(hashFile(archive, 'sha256')).resolves.toBe(
      '0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3',
    );
    await expect(verifyWhisperAssets(archive, model)).rejects.toThrow(
      'archive checksum mismatch',
    );
  });
});
