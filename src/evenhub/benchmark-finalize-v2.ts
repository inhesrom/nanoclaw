import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { loadAndValidateManifestV2 } from './benchmark-corpus-v2.js';
import {
  summarizeMeasurementsV2,
  type BenchmarkMeasurementV2,
  type BenchmarkSummaryV2,
} from './benchmark-runner-v2.js';
import { seededOrder, wordErrorRate } from './benchmark-statistics.js';

interface IntentReviewV2 {
  version: 2;
  reviewer: string;
  reviewedAt: string;
  samples: Array<{
    sampleId: string;
    judgments: [boolean, boolean, boolean, boolean, boolean];
    notes?: string;
  }>;
}

export interface FinalBenchmarkSummaryV2 {
  version: 2;
  decision: 'pass' | 'block';
  finalizedAt: string;
  selectedModel: string | null;
  provider: string;
  intentPassingUtterances: number;
  recommendedMemoryMaxMiB: number | null;
  gates: BenchmarkSummaryV2['preliminaryGates'] & { intent: boolean };
  metrics: Pick<
    BenchmarkSummaryV2,
    | 'aggregateWer'
    | 'timeToFirstPartialMs'
    | 'stopToFinalLatencyMs'
    | 'modelProcessingMs'
    | 'rtf'
    | 'partialRevisions'
    | 'peakRssMiB'
    | 'peakCpuTempC'
    | 'throttlingObserved'
  >;
  hashes: {
    results: string;
    runSummary: string;
    intentReview: string;
    corpus: string;
    model: Record<string, string>;
    runtime: Record<string, string>;
    lockfile: string;
    server: string;
  };
}

export function finalizeBenchmarkV2(
  runDir: string,
  intentReviewPath: string,
  projectRoot = process.cwd(),
): FinalBenchmarkSummaryV2 {
  const resolvedRunDir = fs.realpathSync(path.resolve(runDir));
  const resolvedReview = fs.realpathSync(path.resolve(intentReviewPath));
  const realProject = fs.realpathSync(path.resolve(projectRoot));
  assertOutsideProject(resolvedRunDir, realProject);
  assertOutsideProject(resolvedReview, realProject);
  const summaryPath = path.join(resolvedRunDir, 'run-summary.json');
  const resultsPath = path.join(resolvedRunDir, 'results.jsonl');
  for (const candidate of [resolvedReview, summaryPath, resultsPath]) {
    assertOwnerOnly(candidate);
  }
  const stored = JSON.parse(
    fs.readFileSync(summaryPath, 'utf8'),
  ) as BenchmarkSummaryV2;
  if (stored.version !== 2) throw new Error('run summary is not version 2');
  const review = JSON.parse(
    fs.readFileSync(resolvedReview, 'utf8'),
  ) as IntentReviewV2;
  validateReview(review);
  const manifest = loadAndValidateManifestV2(stored.manifestPath, projectRoot);
  const measurements = readResults(resultsPath);
  validateMeasurements(measurements, manifest, stored);
  const actualHashes = {
    model: hashFiles(manifest.stt.modelComponents),
    runtime: hashFiles(manifest.stt.runtimeComponents),
    lockfile: sha256File(manifest.stt.lockfilePath),
    server: sha256File(manifest.stt.serverPath),
  };
  if (JSON.stringify(actualHashes) !== JSON.stringify(stored.componentHashes)) {
    throw new Error(
      'runtime, model, lockfile, or server changed after the run',
    );
  }
  const summary = summarizeMeasurementsV2(
    manifest,
    resultsPath,
    measurements,
    stored.runSeeds,
    actualHashes,
    stored.createdAt,
  );
  if (JSON.stringify(summary) !== JSON.stringify(stored)) {
    throw new Error('run summary does not match detailed measurements');
  }
  const reviews = new Map(review.samples.map((item) => [item.sampleId, item]));
  if (reviews.size !== 30 || review.samples.length !== 30) {
    throw new Error('intent review must cover exactly 30 unique utterances');
  }
  for (const sample of manifest.samples) {
    if (!reviews.has(sample.id))
      throw new Error(`missing intent review for ${sample.id}`);
  }
  if (
    [...reviews.keys()].some(
      (id) => !manifest.samples.some((sample) => sample.id === id),
    )
  ) {
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
  const result: FinalBenchmarkSummaryV2 = {
    version: 2,
    decision: pass ? 'pass' : 'block',
    finalizedAt: new Date().toISOString(),
    selectedModel: pass ? summary.modelId : null,
    provider: summary.provider,
    intentPassingUtterances,
    recommendedMemoryMaxMiB:
      pass && summary.peakRssMiB !== null
        ? Math.ceil(summary.peakRssMiB * 1.25)
        : null,
    gates,
    metrics: {
      aggregateWer: summary.aggregateWer,
      timeToFirstPartialMs: summary.timeToFirstPartialMs,
      stopToFinalLatencyMs: summary.stopToFinalLatencyMs,
      modelProcessingMs: summary.modelProcessingMs,
      rtf: summary.rtf,
      partialRevisions: summary.partialRevisions,
      peakRssMiB: summary.peakRssMiB,
      peakCpuTempC: summary.peakCpuTempC,
      throttlingObserved: summary.throttlingObserved,
    },
    hashes: {
      results: sha256File(resultsPath),
      runSummary: sha256File(summaryPath),
      intentReview: sha256File(resolvedReview),
      corpus: summary.corpusSha256,
      ...actualHashes,
    },
  };
  atomicWrite(
    path.join(resolvedRunDir, 'final-summary.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  atomicWrite(
    path.join(resolvedRunDir, 'final-summary.md'),
    renderMarkdown(result, summary),
  );
  return result;
}

function validateReview(review: IntentReviewV2): void {
  if (review.version !== 2 || !review.reviewer?.trim()) {
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
      throw new Error('each sample needs five boolean intent judgments');
    }
  }
}

function validateMeasurements(
  measurements: BenchmarkMeasurementV2[],
  manifest: ReturnType<typeof loadAndValidateManifestV2>,
  summary: BenchmarkSummaryV2,
): void {
  if (measurements.length !== 150 || summary.runSeeds.length !== 5) {
    throw new Error('version 2 results require five complete runs');
  }
  for (let run = 1; run <= 5; run += 1) {
    const expected = seededOrder(manifest.samples, summary.runSeeds[run - 1]);
    const actual = measurements
      .filter((item) => item.run === run)
      .sort((left, right) => left.order - right.order);
    if (
      actual.length !== 30 ||
      actual.some(
        (item, index) =>
          item.order !== index + 1 ||
          item.seed !== summary.runSeeds[run - 1] ||
          item.sampleId !== expected[index].id,
      )
    ) {
      throw new Error(`run ${run} does not match deterministic ordering`);
    }
  }
  const samples = new Map(
    manifest.samples.map((sample) => [sample.id, sample]),
  );
  for (const item of measurements) {
    const sample = samples.get(item.sampleId);
    if (!sample) throw new Error('unknown benchmark sample');
    if (
      item.version !== 2 ||
      item.durationMs !== sample.durationMs ||
      item.reference !== sample.reference ||
      item.intent !== sample.intent ||
      item.hashes.pcm !== sample.sha256 ||
      JSON.stringify({
        model: item.hashes.model,
        runtime: item.hashes.runtime,
        lockfile: item.hashes.lockfile,
        server: item.hashes.server,
      }) !== JSON.stringify(summary.componentHashes) ||
      JSON.stringify(item.wer) !==
        JSON.stringify(wordErrorRate(sample.reference, item.hypothesis)) ||
      !Number.isFinite(item.stopToFinalLatencyMs) ||
      item.stopToFinalLatencyMs < 0 ||
      !Number.isFinite(item.modelProcessingMs) ||
      item.modelProcessingMs <= 0 ||
      Math.abs(item.rtf - item.modelProcessingMs / item.durationMs) >
        Number.EPSILON
    ) {
      throw new Error(`result metadata drift for ${item.sampleId}`);
    }
  }
}

function readResults(candidate: string): BenchmarkMeasurementV2[] {
  return fs
    .readFileSync(candidate, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BenchmarkMeasurementV2);
}

function hashFiles(files: string[]): Record<string, string> {
  return Object.fromEntries(
    files.map((candidate) => [candidate, sha256File(candidate)]),
  );
}

function sha256File(candidate: string): string {
  return createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
}

function assertOwnerOnly(candidate: string): void {
  if ((fs.statSync(candidate).mode & 0o077) !== 0) {
    throw new Error(`${candidate} must have owner-only permissions`);
  }
}

function assertOutsideProject(candidate: string, project: string): void {
  const relative = path.relative(project, candidate);
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

function renderMarkdown(
  result: FinalBenchmarkSummaryV2,
  summary: BenchmarkSummaryV2,
): string {
  const gate = (value: boolean) => (value ? 'PASS' : 'FAIL');
  return `# EvenHub streaming STT final decision\n\nDecision: **${result.decision.toUpperCase()}**\n\n- Provider/model: ${summary.provider} / ${summary.modelId}\n- Aggregate normalized WER: ${(summary.aggregateWer * 100).toFixed(2)}% — ${gate(result.gates.wer)}\n- Intent retained for all five hypotheses: ${result.intentPassingUtterances}/30 — ${gate(result.gates.intent)}\n- Stop-to-final p95/max: ${summary.stopToFinalLatencyMs.p95.toFixed(1)} / ${summary.stopToFinalLatencyMs.max.toFixed(1)} ms — ${gate(result.gates.latency)}\n- No current or historical throttling: ${gate(result.gates.noThrottling)}\n- Required metrics present: ${gate(result.gates.metricsPresent)}\n- Complete protocol: ${gate(result.gates.protocolComplete)}\n- Recommended MemoryMax: ${result.recommendedMemoryMaxMiB ?? 'not selected'} MiB\n`;
}
