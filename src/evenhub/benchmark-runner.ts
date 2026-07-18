import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';

import {
  loadAndValidateManifest,
  type ValidatedManifest,
} from './benchmark-corpus.js';
import {
  createPiMetricsCollector,
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
import { createCanonicalWav } from './wav.js';
import { WhisperClient, type WhisperTranscriber } from './whisper-client.js';

export interface BenchmarkMeasurement {
  version: 1;
  run: number;
  order: number;
  seed: number;
  sampleId: string;
  durationMs: number;
  reference: string;
  intent: string;
  hypothesis: string;
  latencyMs: number;
  rtf: number;
  wer: WerCounts;
  pcmSha256: string;
  modelSha256: string;
  binarySha256: string;
  rssMiB: number | null;
  cpuTempC: number | null;
  throttling: HostMetrics['throttling'];
}

export interface BenchmarkSummary {
  version: 1;
  status: 'pending_intent_review';
  createdAt: string;
  manifestPath: string;
  resultsPath: string;
  environment: ValidatedManifest['environment'];
  modelId: string;
  modelPath: string;
  binaryPath: string;
  threads: number;
  processors: number;
  modelSha256: string;
  binarySha256: string;
  corpusSha256: string;
  runs: number;
  runSeeds: number[];
  warmupExcluded: true;
  measurements: number;
  aggregateWer: number;
  werCounts: Omit<WerCounts, 'wer'>;
  latencyMs: { p50: number; p95: number; max: number };
  rtf: { p50: number; p95: number; max: number };
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

export interface RunBenchmarkOptions {
  runs: number;
  seed: number;
  projectRoot?: string;
  transcriber?: WhisperTranscriber;
  metrics?: MetricsCollector;
  clock?: () => number;
  now?: () => Date;
}

export async function runBenchmark(
  manifestPath: string,
  options: RunBenchmarkOptions,
): Promise<{ runDir: string; summary: BenchmarkSummary }> {
  if (options.runs !== 5)
    throw new Error('benchmark requires exactly five runs');
  if (!Number.isSafeInteger(options.seed))
    throw new Error('seed must be an integer');
  const projectRoot = options.projectRoot ?? process.cwd();
  const manifest = loadAndValidateManifest(manifestPath, projectRoot);
  const now = options.now ?? (() => new Date());
  const runDir = path.join(
    path.dirname(manifest.manifestPath),
    `run-${now().toISOString().replace(/[:.]/g, '-')}`,
  );
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.chmodSync(runDir, 0o700);
  const resultsPath = path.join(runDir, 'results.jsonl');
  fs.writeFileSync(resultsPath, '', { mode: 0o600 });

  const transcriber =
    options.transcriber ?? new WhisperClient(manifest.whisper.endpoint);
  const metrics =
    options.metrics ??
    createPiMetricsCollector(
      manifest.whisper.binaryPath,
      manifest.whisper.modelPath,
    );
  const clock = options.clock ?? (() => performance.now());
  const modelSha256 = sha256File(manifest.whisper.modelPath);
  const binarySha256 = sha256File(manifest.whisper.binaryPath);
  const corpus = new Map(
    manifest.samples.map((sample) => [
      sample.id,
      fs.readFileSync(sample.pcmPath),
    ]),
  );

  // Warm the preloaded model once. It is deliberately absent from results.jsonl.
  const warmup = manifest.samples[0];
  await transcriber.transcribe(createCanonicalWav(corpus.get(warmup.id)!));

  const measurements: BenchmarkMeasurement[] = [];
  const seeds: number[] = [];
  for (let run = 0; run < options.runs; run += 1) {
    const seed = runSeed(options.seed, run);
    seeds.push(seed);
    const ordered = seededOrder(manifest.samples, seed);
    for (let order = 0; order < ordered.length; order += 1) {
      const sample = ordered[order];
      const startedAt = clock();
      const wav = createCanonicalWav(corpus.get(sample.id)!);
      const monitored = await monitorOperation(metrics, () =>
        transcriber.transcribe(wav),
      );
      const latencyMs = Math.max(0, clock() - startedAt);
      const measurement: BenchmarkMeasurement = {
        version: 1,
        run: run + 1,
        order: order + 1,
        seed,
        sampleId: sample.id,
        durationMs: sample.durationMs,
        reference: sample.reference,
        intent: sample.intent,
        hypothesis: monitored.value,
        latencyMs,
        rtf: latencyMs / sample.durationMs,
        wer: wordErrorRate(sample.reference, monitored.value),
        pcmSha256: sample.sha256,
        modelSha256,
        binarySha256,
        rssMiB: monitored.metrics.rssMiB,
        cpuTempC: monitored.metrics.cpuTempC,
        throttling: monitored.metrics.throttling,
      };
      measurements.push(measurement);
      fs.appendFileSync(resultsPath, `${JSON.stringify(measurement)}\n`);
    }
  }
  fs.chmodSync(resultsPath, 0o600);

  const summary = summarizeMeasurements(
    manifest,
    resultsPath,
    measurements,
    seeds,
    modelSha256,
    binarySha256,
    now().toISOString(),
  );
  atomicWrite(
    path.join(runDir, 'run-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  atomicWrite(path.join(runDir, 'run-summary.md'), renderRunMarkdown(summary));
  return { runDir, summary };
}

export function summarizeMeasurements(
  manifest: ValidatedManifest,
  resultsPath: string,
  measurements: BenchmarkMeasurement[],
  seeds: number[],
  modelSha256: string,
  binarySha256: string,
  createdAt: string,
): BenchmarkSummary {
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
  const latencies = measurements.map((item) => item.latencyMs);
  const rtfs = measurements.map((item) => item.rtf);
  const rss = measurements.flatMap((item) =>
    item.rssMiB === null ? [] : [item.rssMiB],
  );
  const temperatures = measurements.flatMap((item) =>
    item.cpuTempC === null ? [] : [item.cpuTempC],
  );
  const metricCompleteness = measurements.every(
    (item) =>
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
  const latency = {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: Math.max(...latencies),
  };

  return {
    version: 1,
    status: 'pending_intent_review',
    createdAt,
    manifestPath: manifest.manifestPath,
    resultsPath,
    environment: manifest.environment,
    modelId: manifest.whisper.modelId,
    modelPath: manifest.whisper.modelPath,
    binaryPath: manifest.whisper.binaryPath,
    threads: manifest.whisper.threads,
    processors: manifest.whisper.processors,
    modelSha256,
    binarySha256,
    corpusSha256: manifest.corpusSha256,
    runs: 5,
    runSeeds: seeds,
    warmupExcluded: true,
    measurements: measurements.length,
    aggregateWer,
    werCounts: counts,
    latencyMs: latency,
    rtf: {
      p50: percentile(rtfs, 0.5),
      p95: percentile(rtfs, 0.95),
      max: Math.max(...rtfs),
    },
    peakRssMiB: rss.length ? Math.max(...rss) : null,
    peakCpuTempC: temperatures.length ? Math.max(...temperatures) : null,
    metricCompleteness,
    throttlingObserved,
    preliminaryGates: {
      wer: aggregateWer <= 0.15,
      latency: latency.p95 <= 4_000 && latency.max <= 8_000,
      noThrottling: throttlingObserved === false,
      metricsPresent: metricCompleteness,
      protocolComplete,
    },
  };
}

function renderRunMarkdown(summary: BenchmarkSummary): string {
  const result = (value: boolean) => (value ? 'PASS' : 'FAIL');
  return `# EvenHub Whisper benchmark\n\nStatus: pending manual intent review\n\n- Model: ${summary.modelId}\n- Measurements: ${summary.measurements} (warm-up excluded)\n- Aggregate normalized WER: ${(summary.aggregateWer * 100).toFixed(2)}% — ${result(summary.preliminaryGates.wer)}\n- Latency p50/p95/max: ${summary.latencyMs.p50.toFixed(1)} / ${summary.latencyMs.p95.toFixed(1)} / ${summary.latencyMs.max.toFixed(1)} ms — ${result(summary.preliminaryGates.latency)}\n- RTF p50/p95/max: ${summary.rtf.p50.toFixed(3)} / ${summary.rtf.p95.toFixed(3)} / ${summary.rtf.max.toFixed(3)}\n- Peak RSS: ${summary.peakRssMiB?.toFixed(1) ?? 'missing'} MiB\n- Peak CPU temperature: ${summary.peakCpuTempC?.toFixed(1) ?? 'missing'} C\n- No current or historical throttling: ${result(summary.preliminaryGates.noThrottling)}\n- Required metrics present: ${result(summary.preliminaryGates.metricsPresent)}\n- Complete five-run protocol: ${result(summary.preliminaryGates.protocolComplete)}\n`;
}

function atomicWrite(destination: string, content: string): void {
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
