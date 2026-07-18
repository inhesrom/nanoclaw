import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENHUB_CAPTURE_COUNT,
  EvenHubBenchmarkCapture,
} from './benchmark-capture.js';

describe('EvenHubBenchmarkCapture', () => {
  let root: string;
  let store: string;
  let output: string;
  let source: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-capture-test-'));
    store = path.join(root, 'repo', 'store');
    output = path.join(root, 'corpus');
    source = path.join(root, 'turn.pcm');
    fs.mkdirSync(path.join(root, 'repo'), { recursive: true });
    fs.mkdirSync(output);
    fs.writeFileSync(source, Buffer.alloc(8_000), { mode: 0o600 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is off by default and requires an empty absolute path outside git', () => {
    const capture = new EvenHubBenchmarkCapture(store, path.join(root, 'repo'));
    expect(capture.status()).toEqual({
      armed: false,
      count: EVENHUB_CAPTURE_COUNT,
      captured: 0,
    });
    expect(() => capture.arm('relative')).toThrow(/absolute/);
    const inside = path.join(root, 'repo', 'corpus');
    fs.mkdirSync(inside);
    expect(() => capture.arm(inside)).toThrow(/outside/);
    fs.writeFileSync(path.join(output, 'not-empty'), 'x');
    expect(() => capture.arm(output)).toThrow(/empty/);
  });

  it('uses owner-only permissions and automatically disarms at 30 files', () => {
    const capture = new EvenHubBenchmarkCapture(store, path.join(root, 'repo'));
    capture.arm(output);
    for (let index = 0; index < EVENHUB_CAPTURE_COUNT; index += 1) {
      capture.captureValidatedPcm(source, 250);
    }

    expect(capture.status()).toMatchObject({
      armed: false,
      captured: EVENHUB_CAPTURE_COUNT,
    });
    expect(
      fs.readdirSync(output).filter((name) => name.endsWith('.pcm')),
    ).toHaveLength(EVENHUB_CAPTURE_COUNT);
    expect(fs.statSync(output).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(output, '01.pcm')).mode & 0o777).toBe(0o600);
    expect(
      fs.statSync(path.join(output, 'capture-index.json')).mode & 0o777,
    ).toBe(0o600);
    expect(
      fs.statSync(path.join(store, 'evenhub', 'benchmark-capture.json')).mode &
        0o777,
    ).toBe(0o600);
  });

  it('disarms and removes a partial copy when capture persistence fails', () => {
    const warn = vi.fn();
    const capture = new EvenHubBenchmarkCapture(
      store,
      path.join(root, 'repo'),
      { info: vi.fn(), warn },
    );
    capture.arm(output);
    const rename = vi.spyOn(fs, 'renameSync');
    rename.mockImplementationOnce(() => {
      throw new Error('disk failure');
    });

    expect(() => capture.captureValidatedPcm(source, 250)).not.toThrow();
    expect(capture.status()).toMatchObject({ armed: false, captured: 0 });
    expect(
      fs.readdirSync(output).filter((name) => name.endsWith('.pcm')),
    ).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('disk failure');
  });
});
