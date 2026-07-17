import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';

import {
  loadAndValidateManifestV2,
  type ValidatedManifestV2,
} from './benchmark-corpus-v2.js';
import {
  createSttMetricsCollector,
  monitorOperation,
  type HostMetrics,
  type MetricsCollector,
} from './benchmark-metrics.js';
import {
  percentile,
  runSeed,
  seededOrder,
  wordErrorRate,
  type WerCounts,
} from './benchmark-statistics.js';
import {
  MoonshineClient,
  type SttSnapshot,
  type SttStreamingProvider,
} from './stt-client.js';

export interface BenchmarkHashesV2 {
  pcm: string;
  model: Record<string, string>;
  runtime: Record<string, string>;
  lockfile: string;
  server: string;
}

export interface BenchmarkMeasurementV2 {
  version: 2;
  run: number;
  order: number;
  seed: number;
  sampleId: string;
  durationMs: number;
  reference: string;
  intent: string;
  hypothesis: string;
  timeToFirstPartialMs: number | null;
  stopToFinalLatencyMs: number;
  modelProcessingMs: number;
  rtf: number;
  partialRevisionCount: number;
  wer: WerCounts;
  hashes: BenchmarkHashesV2;
  rssMiB: number | null;
  cpuTempC: number | null;
  throttling: HostMetrics['throttling'];
}

export interface BenchmarkSummaryV2 {
  version: 2;
  status: 'pending_intent_review';
  createdAt: string;
  manifestPath: string;
  resultsPath: string;
  environment: ValidatedManifestV2['environment'];
  provider: string;
  streamingProtocol: string;
  serviceEndpoint: string;
  modelId: string;
  modelArchitecture: string;
  modelPath: string;
  runtimePath: string;
  updateIntervalMs: number;
  componentHashes: Omit<BenchmarkHashesV2, 'pcm'>;
  corpusSha256: string;
  runs: 5;
  runSeeds: number[];
  warmupExcluded: true;
  replayChunkMs: 100;
  measurements: number;
  aggregateWer: number;
  werCounts: Omit<WerCounts, 'wer'>;
  timeToFirstPartialMs: { p50: number; p95: number; max: number } | null;
  stopToFinalLatencyMs: { p50: number; p95: number; max: number };
  modelProcessingMs: { p50: number; p95: number; max: number };
  rtf: { p50: number; p95: number; max: number };
  partialRevisions: { p50: number; p95: number; max: number };
  peakRssMiB: number | null;
  peakCpuTempC: number | null;
  metricCompleteness: boolean;
  throttlingObserved: boolean | null;
  preliminaryGates: {
    wer: boolean;
    latency: boolean;
    noThrottling: boolean;
    metricsPresent: boolean;
    protocolComplete: boolean;
  };
}

export interface RunBenchmarkV2Options {
  runs: number;
  seed: number;
  projectRoot?: string;
  streaming?: SttStreamingProvider;
  metrics?: MetricsCollector;
  clock?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

export async function runBenchmarkV2(
  manifestPath: string,
  options: RunBenchmarkV2Options,
): Promise<{ runDir: string; summary: BenchmarkSummaryV2 }> {
  if (options.runs !== 5)
    throw new Error('benchmark requires exactly five runs');
  if (!Number.isSafeInteger(options.seed))
    throw new Error('seed must be an integer');
  const projectRoot = options.projectRoot ?? process.cwd();
  const manifest = loadAndValidateManifestV2(manifestPath, projectRoot);
  const now = options.now ?? (() => new Date());
  const runDir = path.join(
    path.dirname(manifest.manifestPath),
    `run-${now().toISOString().replace(/[:.]/g, '-')}`,
  );
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.chmodSync(runDir, 0o700);
  const resultsPath = path.join(runDir, 'results.jsonl');
  fs.writeFileSync(resultsPath, '', { mode: 0o600 });

  const streaming =
    options.streaming ??
    new MoonshineClient(
      new URL('/v1/transcribe', manifest.stt.serviceEndpoint).toString(),
    );
  const metrics =
    options.metrics ??
    createSttMetricsCollector([path.basename(manifest.stt.serverPath)]);
  const clock = options.clock ?? (() => performance.now());
  const delay =
    options.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const componentHashes = {
    model: hashFiles(manifest.stt.modelComponents),
    runtime: hashFiles(manifest.stt.runtimeComponents),
    lockfile: sha256File(manifest.stt.lockfilePath),
    server: sha256File(manifest.stt.serverPath),
  };
  const corpus = new Map(
    manifest.samples.map((sample) => [
      sample.id,
      fs.readFileSync(sample.pcmPath),
    ]),
  );

  // Exactly one real-time warm-up; deliberately absent from results.jsonl.
  await replayStreaming(
    streaming,
    corpus.get(manifest.samples[0].id)!,
    clock,
    delay,
  );

  const measurements: BenchmarkMeasurementV2[] = [];
  const seeds: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const seed = runSeed(options.seed, run);
    seeds.push(seed);
    const ordered = seededOrder(manifest.samples, seed);
    for (let order = 0; order < ordered.length; order += 1) {
      const sample = ordered[order];
      const pcm = corpus.get(sample.id)!;
      const monitored = await monitorOperation(metrics, () =>
        replayStreaming(streaming, pcm, clock, delay),
      );
      const replay = monitored.value;
      const measurement: BenchmarkMeasurementV2 = {
        version: 2,
        run: run + 1,
        order: order + 1,
        seed,
        sampleId: sample.id,
        durationMs: sample.durationMs,
        reference: sample.reference,
        intent: sample.intent,
        hypothesis: replay.hypothesis,
        timeToFirstPartialMs: replay.timeToFirstPartialMs,
        stopToFinalLatencyMs: replay.stopToFinalLatencyMs,
        modelProcessingMs: replay.modelProcessingMs,
        rtf: replay.modelProcessingMs / sample.durationMs,
        partialRevisionCount: replay.partialRevisionCount,
        wer: wordErrorRate(sample.reference, replay.hypothesis),
        hashes: { pcm: sample.sha256, ...componentHashes },
        rssMiB: monitored.metrics.rssMiB,
        cpuTempC: monitored.metrics.cpuTempC,
        throttling: monitored.metrics.throttling,
      };
      measurements.push(measurement);
      fs.appendFileSync(resultsPath, `${JSON.stringify(measurement)}\n`);
    }
  }
  fs.chmodSync(resultsPath, 0o600);
  const summary = summarizeMeasurementsV2(
    manifest,
    resultsPath,
    measurements,
    seeds,
    componentHashes,
    now().toISOString(),
  );
  atomicWrite(
    path.join(runDir, 'run-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  atomicWrite(path.join(runDir, 'run-summary.md'), renderMarkdown(summary));
  return { runDir, summary };
}

interface ReplayResult {
  hypothesis: string;
  timeToFirstPartialMs: number | null;
  stopToFinalLatencyMs: number;
  modelProcessingMs: number;
  partialRevisionCount: number;
}

export async function replayStreaming(
  provider: SttStreamingProvider,
  pcm: Uint8Array,
  clock: () => number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<ReplayResult> {
  const startedAt = clock();
  let firstPartialAt: number | null = null;
  let revisions = 0;
  let previous = '';
  const stream = await provider.connect((snapshot: SttSnapshot) => {
    const current = `${snapshot.finalText}\u0000${snapshot.interimText}`;
    if (current === previous) return;
    previous = current;
    revisions += 1;
    if (
      firstPartialAt === null &&
      `${snapshot.finalText} ${snapshot.interimText}`.trim()
    ) {
      firstPartialAt = clock();
    }
  });
  try {
    for (let offset = 0; offset < pcm.byteLength; offset += 3_200) {
      const chunk = pcm.subarray(
        offset,
        Math.min(offset + 3_200, pcm.byteLength),
      );
      stream.addAudio(chunk);
      await delay(chunk.byteLength / 32);
    }
    const stoppedAt = clock();
    const final = await stream.finish();
    return {
      hypothesis: final.text,
      timeToFirstPartialMs:
        firstPartialAt === null
          ? null
          : Math.max(0, firstPartialAt - startedAt),
      stopToFinalLatencyMs: Math.max(0, clock() - stoppedAt),
      modelProcessingMs: final.processingMs,
      partialRevisionCount: revisions,
    };
  } finally {
    stream.close();
  }
}

export function summarizeMeasurementsV2(
  manifest: ValidatedManifestV2,
  resultsPath: string,
  measurements: BenchmarkMeasurementV2[],
  seeds: number[],
  componentHashes: Omit<BenchmarkHashesV2, 'pcm'>,
  createdAt: string,
): BenchmarkSummaryV2 {
  const counts = measurements.reduce(
    (total, item) => ({
      substitutions: total.substitutions + item.wer.substitutions,
      deletions: total.deletions + item.wer.deletions,
      insertions: total.insertions + item.wer.insertions,
      errors: total.errors + item.wer.errors,
      referenceWords: total.referenceWords + item.wer.referenceWords,
    }),
    {
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      errors: 0,
      referenceWords: 0,
    },
  );
  const partials = measurements.flatMap((item) =>
    item.timeToFirstPartialMs === null ? [] : [item.timeToFirstPartialMs],
  );
  const stopLatencies = measurements.map((item) => item.stopToFinalLatencyMs);
  const processing = measurements.map((item) => item.modelProcessingMs);
  const rtfs = measurements.map((item) => item.rtf);
  const revisions = measurements.map((item) => item.partialRevisionCount);
  const rss = measurements.flatMap((item) =>
    item.rssMiB === null ? [] : [item.rssMiB],
  );
  const temperatures = measurements.flatMap((item) =>
    item.cpuTempC === null ? [] : [item.cpuTempC],
  );
  const completeMetrics = measurements.every(
    (item) =>
      item.timeToFirstPartialMs !== null &&
      Number.isFinite(item.stopToFinalLatencyMs) &&
      Number.isFinite(item.modelProcessingMs) &&
      item.modelProcessingMs > 0 &&
      Number.isInteger(item.partialRevisionCount) &&
      item.rssMiB !== null &&
      item.rssMiB > 0 &&
      item.cpuTempC !== null &&
      item.throttling.raw !== null,
  );
  const knownThrottle = measurements.filter(
    (item) =>
      item.throttling.current !== null && item.throttling.historical !== null,
  );
  const throttlingObserved =
    knownThrottle.length === 0
      ? null
      : knownThrottle.some(
          (item) => item.throttling.current || item.throttling.historical,
        );
  const protocolComplete =
    measurements.length === 150 &&
    seeds.length === 5 &&
    manifest.samples.every(
      (sample) =>
        measurements.filter((item) => item.sampleId === sample.id).length === 5,
    );
  const aggregateWer = counts.referenceWords
    ? counts.errors / counts.referenceWords
    : 1;
  const latency = stats(stopLatencies);
  return {
    version: 2,
    status: 'pending_intent_review',
    createdAt,
    manifestPath: manifest.manifestPath,
    resultsPath,
    environment: manifest.environment,
    provider: manifest.stt.provider,
    streamingProtocol: manifest.stt.streamingProtocol,
    serviceEndpoint: manifest.stt.serviceEndpoint,
    modelId: manifest.stt.modelId,
    modelArchitecture: manifest.stt.modelArchitecture,
    modelPath: manifest.stt.modelPath,
    runtimePath: manifest.stt.runtimePath,
    updateIntervalMs: manifest.stt.updateIntervalMs,
    componentHashes,
    corpusSha256: manifest.corpusSha256,
    runs: 5,
    runSeeds: seeds,
    warmupExcluded: true,
    replayChunkMs: 100,
    measurements: measurements.length,
    aggregateWer,
    werCounts: counts,
    timeToFirstPartialMs: partials.length ? stats(partials) : null,
    stopToFinalLatencyMs: latency,
    modelProcessingMs: stats(processing),
    rtf: stats(rtfs),
    partialRevisions: stats(revisions),
    peakRssMiB: rss.length ? Math.max(...rss) : null,
    peakCpuTempC: temperatures.length ? Math.max(...temperatures) : null,
    metricCompleteness: completeMetrics,
    throttlingObserved,
    preliminaryGates: {
      wer: aggregateWer <= 0.15,
      latency: latency.p95 <= 1_000 && latency.max <= 2_000,
      noThrottling: throttlingObserved === false,
      metricsPresent: completeMetrics,
      protocolComplete,
    },
  };
}

function stats(values: number[]): { p50: number; p95: number; max: number } {
  if (!values.length) throw new Error('required benchmark metric is missing');
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function hashFiles(files: string[]): Record<string, string> {
  return Object.fromEntries(
    files.map((candidate) => [candidate, sha256File(candidate)]),
  );
}

function sha256File(candidate: string): string {
  return createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
}

function atomicWrite(destination: string, content: string): void {
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
}

function renderMarkdown(summary: BenchmarkSummaryV2): string {
  const gate = (value: boolean) => (value ? 'PASS' : 'FAIL');
  return `# EvenHub streaming STT benchmark\n\nStatus: pending manual intent review\n\n- Provider/model: ${summary.provider} / ${summary.modelId}\n- Measurements: ${summary.measurements} (warm-up excluded)\n- Aggregate normalized WER: ${(summary.aggregateWer * 100).toFixed(2)}% — ${gate(summary.preliminaryGates.wer)}\n- First partial p50/p95/max: ${summary.timeToFirstPartialMs ? `${summary.timeToFirstPartialMs.p50.toFixed(1)} / ${summary.timeToFirstPartialMs.p95.toFixed(1)} / ${summary.timeToFirstPartialMs.max.toFixed(1)} ms` : 'missing'}\n- Stop-to-final p50/p95/max: ${summary.stopToFinalLatencyMs.p50.toFixed(1)} / ${summary.stopToFinalLatencyMs.p95.toFixed(1)} / ${summary.stopToFinalLatencyMs.max.toFixed(1)} ms — ${gate(summary.preliminaryGates.latency)}\n- Model processing p50/p95/max: ${summary.modelProcessingMs.p50.toFixed(1)} / ${summary.modelProcessingMs.p95.toFixed(1)} / ${summary.modelProcessingMs.max.toFixed(1)} ms\n- RTF p50/p95/max: ${summary.rtf.p50.toFixed(3)} / ${summary.rtf.p95.toFixed(3)} / ${summary.rtf.max.toFixed(3)}\n- Partial revisions p50/p95/max: ${summary.partialRevisions.p50} / ${summary.partialRevisions.p95} / ${summary.partialRevisions.max}\n- Peak RSS: ${summary.peakRssMiB?.toFixed(1) ?? 'missing'} MiB\n- Peak CPU temperature: ${summary.peakCpuTempC?.toFixed(1) ?? 'missing'} C\n- No current or historical throttling: ${gate(summary.preliminaryGates.noThrottling)}\n- Required metrics present: ${gate(summary.preliminaryGates.metricsPresent)}\n- Complete five-run protocol: ${gate(summary.preliminaryGates.protocolComplete)}\n`;
}
