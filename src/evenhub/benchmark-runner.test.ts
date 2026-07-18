import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { finalizeBenchmark } from './benchmark-finalize.js';
import { runBenchmark } from './benchmark-runner.js';
import { createBenchmarkFixture } from './benchmark-test-fixtures.js';

describe('EvenHub benchmark runner', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runner-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('discards one warm-up and writes five deterministic serial runs', async () => {
    const fixture = createBenchmarkFixture(root);
    const transcribe = vi.fn(async () => 'send sample 0 number 0');
    let tick = 0;
    const result = await runBenchmark(fixture.manifestPath, {
      runs: 5,
      seed: 8675309,
      projectRoot: fixture.projectRoot,
      transcriber: { transcribe },
      metrics: {
        sample: () => ({
          rssMiB: 400,
          cpuTempC: 55,
          throttling: { raw: 0, current: false, historical: false },
        }),
      },
      clock: () => (tick += 100),
      now: () => new Date('2026-07-16T01:00:00.000Z'),
    });

    const lines = fs
      .readFileSync(path.join(result.runDir, 'results.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(transcribe).toHaveBeenCalledTimes(151);
    expect(lines).toHaveLength(150);
    expect(result.summary.warmupExcluded).toBe(true);
    expect(result.summary.runSeeds).toEqual([
      8675309, 2663111078, 1022579551, 3677015320, 2036483793,
    ]);
    expect(result.summary.latencyMs).toEqual({ p50: 100, p95: 100, max: 100 });
    expect(result.summary.preliminaryGates).toEqual({
      wer: false,
      latency: true,
      noThrottling: true,
      metricsPresent: true,
      protocolComplete: true,
    });
    expect(fs.statSync(result.runDir).mode & 0o777).toBe(0o700);
    expect(
      fs.statSync(path.join(result.runDir, 'results.jsonl')).mode & 0o777,
    ).toBe(0o600);
  });

  it('passes final gates only after every hypothesis receives intent review', async () => {
    const fixture = createBenchmarkFixture(root);
    let tick = 0;
    const result = await runBenchmark(fixture.manifestPath, {
      runs: 5,
      seed: 42,
      projectRoot: fixture.projectRoot,
      transcriber: {
        async transcribe(wav) {
          const marker = Buffer.from(wav).readInt16LE(44);
          const band = Math.floor(marker / 100);
          const index = marker % 100;
          return `send sample ${band} number ${index}`;
        },
      },
      metrics: {
        sample: () => ({
          rssMiB: 401.2,
          cpuTempC: 54.5,
          throttling: { raw: 0, current: false, historical: false },
        }),
      },
      clock: () => (tick += 50),
      now: () => new Date('2026-07-16T02:00:00.000Z'),
    });
    expect(result.summary.aggregateWer).toBe(0);
    const reviewPath = path.join(root, 'intent-review.json');
    fs.writeFileSync(
      reviewPath,
      `${JSON.stringify({
        version: 1,
        reviewer: 'human tester',
        reviewedAt: '2026-07-16T03:00:00.000Z',
        samples: fixture.manifest.samples.map((sample) => ({
          sampleId: sample.id,
          judgments: [true, true, true, true, true],
        })),
      })}\n`,
      { mode: 0o600 },
    );

    const final = finalizeBenchmark(
      result.runDir,
      reviewPath,
      fixture.projectRoot,
    );
    expect(final.decision).toBe('pass');
    expect(final.intentPassingUtterances).toBe(30);
    expect(final.recommendedMemoryMaxMiB).toBe(502);
    expect(fs.existsSync(path.join(result.runDir, 'final-summary.md'))).toBe(
      true,
    );
  });
});
