import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAndValidateManifestV2 } from './benchmark-corpus-v2.js';
import { finalizeBenchmarkV2 } from './benchmark-finalize-v2.js';
import {
  runBenchmarkV2,
  summarizeMeasurementsV2,
  type BenchmarkMeasurementV2,
} from './benchmark-runner-v2.js';
import { createBenchmarkFixtureV2 } from './benchmark-test-fixtures.js';
import type { SttStreamingProvider } from './stt-client.js';

describe('provider-neutral streaming benchmark v2', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runner-v2-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('paces 100ms PCM chunks, excludes one warm-up, and preserves seeded order', async () => {
    const fixture = createBenchmarkFixtureV2(root);
    let clock = 0;
    let connections = 0;
    const delays: number[] = [];
    const streaming: SttStreamingProvider = {
      async connect(onSnapshot) {
        connections += 1;
        const chunks: Uint8Array[] = [];
        let emitted = false;
        return {
          addAudio(chunk) {
            chunks.push(new Uint8Array(chunk));
            if (!emitted) {
              emitted = true;
              onSnapshot({ finalText: '', interimText: 'send' });
            }
          },
          async finish() {
            clock += 900;
            const pcm = Buffer.concat(chunks);
            const marker = pcm.readInt16LE(0);
            const band = Math.floor(marker / 100);
            const index = marker % 100;
            return {
              text: `send sample ${band} number ${index}`,
              processingMs: 50,
            };
          },
          close() {},
        };
      },
    };
    const result = await runBenchmarkV2(fixture.manifestPath, {
      runs: 5,
      seed: 8675309,
      projectRoot: fixture.projectRoot,
      streaming,
      metrics: {
        sample: () => ({
          rssMiB: 500,
          cpuTempC: 55,
          throttling: { raw: 0, current: false, historical: false },
        }),
      },
      clock: () => clock,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
      },
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    });

    expect(connections).toBe(151);
    expect(
      fs
        .readFileSync(path.join(result.runDir, 'results.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(150);
    expect(
      delays.every((milliseconds) => milliseconds > 0 && milliseconds <= 100),
    ).toBe(true);
    expect(delays).toContain(100);
    expect(result.summary).toMatchObject({
      warmupExcluded: true,
      replayChunkMs: 100,
      runSeeds: [8675309, 2663111078, 1022579551, 3677015320, 2036483793],
      aggregateWer: 0,
      stopToFinalLatencyMs: { p50: 900, p95: 900, max: 900 },
      preliminaryGates: {
        wer: true,
        latency: true,
        noThrottling: true,
        metricsPresent: true,
        protocolComplete: true,
      },
    });
    expect(Object.keys(result.summary.componentHashes.model)).toEqual([
      fixture.manifest.stt.modelComponents[0],
    ]);
    const reviewPath = path.join(root, 'intent-review-v2.json');
    fs.writeFileSync(
      reviewPath,
      `${JSON.stringify({
        version: 2,
        reviewer: 'physical tester',
        reviewedAt: '2026-07-17T01:00:00.000Z',
        samples: fixture.manifest.samples.map((sample) => ({
          sampleId: sample.id,
          judgments: [true, true, true, true, true],
        })),
      })}\n`,
      { mode: 0o600 },
    );
    const final = finalizeBenchmarkV2(
      result.runDir,
      reviewPath,
      fixture.projectRoot,
    );
    expect(final).toMatchObject({
      decision: 'pass',
      selectedModel: 'moonshine-streaming-small-en',
      intentPassingUtterances: 30,
      recommendedMemoryMaxMiB: 625,
    });
  });

  it('enforces the strict p95/max latency gate and fails missing metrics', () => {
    const fixture = createBenchmarkFixtureV2(root);
    const manifest = loadAndValidateManifestV2(
      fixture.manifestPath,
      fixture.projectRoot,
    );
    const hashes = {
      model: {},
      runtime: {},
      lockfile: 'a'.repeat(64),
      server: 'b'.repeat(64),
    };
    const measurements = manifest.samples.flatMap((sample, sampleIndex) =>
      Array.from(
        { length: 5 },
        (_, runIndex): BenchmarkMeasurementV2 => ({
          version: 2,
          run: runIndex + 1,
          order: sampleIndex + 1,
          seed: runIndex,
          sampleId: sample.id,
          durationMs: sample.durationMs,
          reference: sample.reference,
          intent: sample.intent,
          hypothesis: sample.reference,
          timeToFirstPartialMs: 100,
          stopToFinalLatencyMs:
            sampleIndex === 29 && runIndex === 4 ? 2_000 : 1_000,
          modelProcessingMs: 100,
          rtf: 100 / sample.durationMs,
          partialRevisionCount: 1,
          wer: {
            substitutions: 0,
            deletions: 0,
            insertions: 0,
            errors: 0,
            referenceWords: 5,
            wer: 0,
          },
          hashes: { pcm: sample.sha256, ...hashes },
          rssMiB: 500,
          cpuTempC: 55,
          throttling: { raw: 0, current: false, historical: false },
        }),
      ),
    );
    const passing = summarizeMeasurementsV2(
      manifest,
      '/tmp/results.jsonl',
      measurements,
      [0, 1, 2, 3, 4],
      hashes,
      '2026-07-17T00:00:00.000Z',
    );
    expect(passing.preliminaryGates.latency).toBe(true);

    measurements[0].stopToFinalLatencyMs = 2_001;
    measurements[0].timeToFirstPartialMs = null;
    const blocked = summarizeMeasurementsV2(
      manifest,
      '/tmp/results.jsonl',
      measurements,
      [0, 1, 2, 3, 4],
      hashes,
      '2026-07-17T00:00:00.000Z',
    );
    expect(blocked.preliminaryGates.latency).toBe(false);
    expect(blocked.preliminaryGates.metricsPresent).toBe(false);
    expect(blocked.timeToFirstPartialMs).not.toBeNull();
  });

  it('requires the fixed production loopback endpoint', () => {
    const fixture = createBenchmarkFixtureV2(root);
    fixture.manifest.stt.serviceEndpoint = 'http://localhost:8178';
    fs.writeFileSync(
      fixture.manifestPath,
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
    );

    expect(() =>
      loadAndValidateManifestV2(fixture.manifestPath, fixture.projectRoot),
    ).toThrow('STT benchmark endpoint must be http://127.0.0.1:8178');
  });
});
