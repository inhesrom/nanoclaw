import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { loadAndValidateManifest } from './benchmark-corpus.js';
import type {
  BenchmarkMeasurement,
  BenchmarkSummary,
} from './benchmark-runner.js';
import { summarizeMeasurements } from './benchmark-runner.js';
import { seededOrder, wordErrorRate } from './benchmark-statistics.js';

interface IntentReview {
  version: 1;
  reviewer: string;
  reviewedAt: string;
  samples: Array<{
    sampleId: string;
    judgments: [boolean, boolean, boolean, boolean, boolean];
    notes?: string;
  }>;
}

export interface FinalBenchmarkSummary {
  version: 1;
  decision: 'pass' | 'block';
  finalizedAt: string;
  selectedModel: string | null;
  environment: BenchmarkSummary['environment'];
  runSeeds: number[];
  intentPassingUtterances: number;
  recommendedMemoryMaxMiB: number | null;
  gates: BenchmarkSummary['preliminaryGates'] & { intent: boolean };
  metrics: Pick<
    BenchmarkSummary,
    | 'aggregateWer'
    | 'latencyMs'
    | 'rtf'
    | 'peakRssMiB'
    | 'peakCpuTempC'
    | 'throttlingObserved'
  >;
  hashes: {
    resultsSha256: string;
    runSummarySha256: string;
    intentReviewSha256: string;
    modelSha256: string;
    binarySha256: string;
    corpusSha256: string;
  };
}

export function finalizeBenchmark(
  runDir: string,
  intentReviewPath: string,
  projectRoot = process.cwd(),
): FinalBenchmarkSummary {
  const resolvedRunDir = fs.realpathSync(path.resolve(runDir));
  const resolvedReview = fs.realpathSync(path.resolve(intentReviewPath));
  const realProjectRoot = fs.realpathSync(path.resolve(projectRoot));
  assertOutsideProject(resolvedRunDir, realProjectRoot);
  assertOutsideProject(resolvedReview, realProjectRoot);
  assertOwnerOnly(resolvedReview);
  const runSummaryPath = path.join(resolvedRunDir, 'run-summary.json');
  const resultsPath = path.join(resolvedRunDir, 'results.jsonl');
  assertOwnerOnly(runSummaryPath);
  assertOwnerOnly(resultsPath);
  const storedSummary = JSON.parse(
    fs.readFileSync(runSummaryPath, 'utf8'),
  ) as BenchmarkSummary;
  const review = JSON.parse(
    fs.readFileSync(resolvedReview, 'utf8'),
  ) as IntentReview;
  validateReview(review);
  const measurements = readResults(resultsPath);
  const manifest = loadAndValidateManifest(
    storedSummary.manifestPath,
    projectRoot,
  );
  validateMeasurements(measurements, manifest, storedSummary);
  const actualModelSha256 = sha256File(manifest.whisper.modelPath);
  const actualBinarySha256 = sha256File(manifest.whisper.binaryPath);
  if (
    actualModelSha256 !== storedSummary.modelSha256 ||
    actualBinarySha256 !== storedSummary.binarySha256
  ) {
    throw new Error('model or binary changed after the benchmark run');
  }
  const summary = summarizeMeasurements(
    manifest,
    resultsPath,
    measurements,
    storedSummary.runSeeds,
    actualModelSha256,
    actualBinarySha256,
    storedSummary.createdAt,
  );
  if (JSON.stringify(summary) !== JSON.stringify(storedSummary)) {
    throw new Error('run summary does not match the detailed measurements');
  }
  const sampleIds = [...new Set(measurements.map((item) => item.sampleId))];
  if (sampleIds.length !== 30 || review.samples.length !== 30) {
    throw new Error('intent review must cover all 30 utterances');
  }
  const reviews = new Map(review.samples.map((item) => [item.sampleId, item]));
  for (const sampleId of sampleIds) {
    if (!reviews.has(sampleId))
      throw new Error(`missing intent review for ${sampleId}`);
    const runCount = measurements.filter(
      (item) => item.sampleId === sampleId,
    ).length;
    if (runCount !== 5)
      throw new Error(`results do not contain five runs for ${sampleId}`);
  }
  if ([...reviews.keys()].some((sampleId) => !sampleIds.includes(sampleId))) {
    throw new Error('intent review contains an unknown sample');
  }
  const intentPassingUtterances = review.samples.filter((item) =>
    item.judgments.every(Boolean),
  ).length;
  const gates = {
    ...summary.preliminaryGates,
    intent: intentPassingUtterances >= 28,
  };
  const pass = Object.values(gates).every(Boolean);
  const result: FinalBenchmarkSummary = {
    version: 1,
    decision: pass ? 'pass' : 'block',
    finalizedAt: new Date().toISOString(),
    selectedModel: pass ? summary.modelId : null,
    environment: summary.environment,
    runSeeds: summary.runSeeds,
    intentPassingUtterances,
    recommendedMemoryMaxMiB:
      pass && summary.peakRssMiB !== null
        ? Math.ceil(summary.peakRssMiB * 1.25)
        : null,
    gates,
    metrics: {
      aggregateWer: summary.aggregateWer,
      latencyMs: summary.latencyMs,
      rtf: summary.rtf,
      peakRssMiB: summary.peakRssMiB,
      peakCpuTempC: summary.peakCpuTempC,
      throttlingObserved: summary.throttlingObserved,
    },
    hashes: {
      resultsSha256: sha256File(resultsPath),
      runSummarySha256: sha256File(runSummaryPath),
      intentReviewSha256: sha256File(resolvedReview),
      modelSha256: summary.modelSha256,
      binarySha256: summary.binarySha256,
      corpusSha256: summary.corpusSha256,
    },
  };
  atomicWrite(
    path.join(resolvedRunDir, 'final-summary.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  atomicWrite(
    path.join(resolvedRunDir, 'final-summary.md'),
    renderFinalMarkdown(result, summary),
  );
  return result;
}

function validateReview(review: IntentReview): void {
  if (review.version !== 1 || !review.reviewer?.trim()) {
    throw new Error('intent review version and reviewer are required');
  }
  if (!Number.isFinite(Date.parse(review.reviewedAt))) {
    throw new Error('intent review reviewedAt must be a timestamp');
  }
  if (!Array.isArray(review.samples))
    throw new Error('intent review samples are required');
  for (const sample of review.samples) {
    if (
      !sample.sampleId?.trim() ||
      !Array.isArray(sample.judgments) ||
      sample.judgments.length !== 5 ||
      sample.judgments.some((value) => typeof value !== 'boolean')
    ) {
      throw new Error(
        'every intent review sample needs five boolean judgments',
      );
    }
  }
}

function readResults(resultsPath: string): BenchmarkMeasurement[] {
  return fs
    .readFileSync(resultsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BenchmarkMeasurement);
}

function validateMeasurements(
  measurements: BenchmarkMeasurement[],
  manifest: ReturnType<typeof loadAndValidateManifest>,
  summary: BenchmarkSummary,
): void {
  if (
    summary.runSeeds.length !== 5 ||
    summary.runSeeds.some((seed) => !Number.isInteger(seed))
  ) {
    throw new Error('run summary must contain five integer ordering seeds');
  }
  const samples = new Map(
    manifest.samples.map((sample) => [sample.id, sample]),
  );
  const runOrders = new Set<string>();
  for (const measurement of measurements) {
    const sample = samples.get(measurement.sampleId);
    if (!sample)
      throw new Error(`unknown result sample ${measurement.sampleId}`);
    if (
      !Number.isInteger(measurement.run) ||
      measurement.run < 1 ||
      measurement.run > 5 ||
      !Number.isInteger(measurement.order) ||
      measurement.order < 1 ||
      measurement.order > 30 ||
      measurement.seed !== summary.runSeeds[measurement.run - 1]
    ) {
      throw new Error(`invalid run metadata for ${measurement.sampleId}`);
    }
    const runOrder = `${measurement.run}:${measurement.order}`;
    if (runOrders.has(runOrder))
      throw new Error(`duplicate result order ${runOrder}`);
    runOrders.add(runOrder);
    if (
      measurement.reference !== sample.reference ||
      measurement.intent !== sample.intent ||
      measurement.durationMs !== sample.durationMs ||
      measurement.pcmSha256 !== sample.sha256 ||
      measurement.modelSha256 !== summary.modelSha256 ||
      measurement.binarySha256 !== summary.binarySha256
    ) {
      throw new Error(`result metadata drift for ${measurement.sampleId}`);
    }
    const expectedWer = wordErrorRate(sample.reference, measurement.hypothesis);
    if (JSON.stringify(expectedWer) !== JSON.stringify(measurement.wer)) {
      throw new Error(`WER counts do not match for ${measurement.sampleId}`);
    }
    if (
      !Number.isFinite(measurement.latencyMs) ||
      measurement.latencyMs < 0 ||
      !Number.isFinite(measurement.rtf) ||
      Math.abs(measurement.rtf - measurement.latencyMs / sample.durationMs) >
        Number.EPSILON
    ) {
      throw new Error(`invalid timing metrics for ${measurement.sampleId}`);
    }
    const flags = measurement.throttling;
    if (
      (measurement.rssMiB !== null &&
        (!Number.isFinite(measurement.rssMiB) || measurement.rssMiB < 0)) ||
      (measurement.cpuTempC !== null &&
        !Number.isFinite(measurement.cpuTempC)) ||
      (flags.raw !== null &&
        (!Number.isInteger(flags.raw) ||
          flags.raw < 0 ||
          flags.current !== ((flags.raw & 0xf) !== 0) ||
          flags.historical !== ((flags.raw & 0xf0000) !== 0)))
    ) {
      throw new Error(`invalid host metrics for ${measurement.sampleId}`);
    }
  }
  for (let run = 1; run <= 5; run += 1) {
    const expected = seededOrder(manifest.samples, summary.runSeeds[run - 1]);
    const actual = measurements
      .filter((measurement) => measurement.run === run)
      .sort((left, right) => left.order - right.order);
    if (
      actual.length !== 30 ||
      actual.some(
        (measurement, index) => measurement.sampleId !== expected[index].id,
      )
    ) {
      throw new Error(`run ${run} does not match its seeded ordering`);
    }
  }
}

function renderFinalMarkdown(
  result: FinalBenchmarkSummary,
  summary: BenchmarkSummary,
): string {
  const status = (value: boolean) => (value ? 'PASS' : 'FAIL');
  return `# EvenHub Whisper final decision\n\nDecision: **${result.decision.toUpperCase()}**\n\n- Model: ${summary.modelId}\n- Aggregate normalized WER: ${(summary.aggregateWer * 100).toFixed(2)}% — ${status(result.gates.wer)}\n- Intent retained for all five hypotheses: ${result.intentPassingUtterances}/30 — ${status(result.gates.intent)}\n- Latency p95/max: ${summary.latencyMs.p95.toFixed(1)} / ${summary.latencyMs.max.toFixed(1)} ms — ${status(result.gates.latency)}\n- No current or historical throttling: ${status(result.gates.noThrottling)}\n- Required metrics present: ${status(result.gates.metricsPresent)}\n- Complete protocol: ${status(result.gates.protocolComplete)}\n- Recommended MemoryMax: ${result.recommendedMemoryMaxMiB ?? 'not selected'} MiB\n`;
}

function assertOwnerOnly(file: string): void {
  if ((fs.statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${file} must have owner-only permissions`);
  }
}

function assertOutsideProject(candidate: string, projectRoot: string): void {
  const relative = path.relative(path.resolve(projectRoot), candidate);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    throw new Error('benchmark artifacts must remain outside the git worktree');
  }
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
