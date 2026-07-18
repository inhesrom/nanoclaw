#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';

const [candidatePath, finalSummaryPath, profilePath, memoryDropInPath] =
  process.argv.slice(2);
if (!candidatePath || !finalSummaryPath || !profilePath || !memoryDropInPath) {
  throw new Error(
    'usage: select-profile CANDIDATE FINAL_SUMMARY SELECTED_PROFILE MEMORY_DROP_IN',
  );
}
for (const output of [profilePath, memoryDropInPath]) {
  if (existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
}
if ((statSync(finalSummaryPath).mode & 0o077) !== 0) {
  throw new Error('final benchmark summary must be owner-only');
}

const candidateBytes = readFileSync(candidatePath);
const finalBytes = readFileSync(finalSummaryPath);
const candidate = JSON.parse(candidateBytes.toString('utf8'));
const final = JSON.parse(finalBytes.toString('utf8'));
if (
  candidate.version !== 1 ||
  candidate.selectionStatus !== 'candidate' ||
  candidate.evidence !== null
) {
  throw new Error('candidate profile is invalid or already selected');
}
if (
  final.version !== 2 ||
  final.decision !== 'pass' ||
  final.provider !== candidate.provider ||
  final.selectedModel !== candidate.modelId
) {
  throw new Error('final benchmark does not select this candidate');
}
if (
  !final.gates ||
  Object.values(final.gates).length !== 6 ||
  !Object.values(final.gates).every((value) => value === true)
) {
  throw new Error('every benchmark gate must explicitly pass');
}
if (
  !Number.isSafeInteger(final.recommendedMemoryMaxMiB) ||
  final.recommendedMemoryMaxMiB <= 0 ||
  !Number.isFinite(final.metrics?.peakRssMiB) ||
  final.recommendedMemoryMaxMiB !== Math.ceil(final.metrics.peakRssMiB * 1.25)
) {
  throw new Error('benchmark MemoryMax recommendation is invalid');
}
if (
  final.hashes?.lockfile !== candidate.runtimeLockSha256 ||
  final.hashes?.server !== candidate.serverSha256 ||
  !sameHashes(final.hashes?.model, candidate.components) ||
  !sameHashes(final.hashes?.runtime, candidate.runtimeComponents)
) {
  throw new Error('candidate component hashes do not match benchmark evidence');
}

const profile = {
  ...candidate,
  selectionStatus: 'selected',
  evidence: {
    decision: final.decision,
    finalizedAt: final.finalizedAt,
    finalSummarySha256: sha256(finalBytes),
    resultsSha256: final.hashes.results,
    runSummarySha256: final.hashes.runSummary,
    intentReviewSha256: final.hashes.intentReview,
    corpusSha256: final.hashes.corpus,
    intentPassingUtterances: final.intentPassingUtterances,
    gates: final.gates,
    metrics: final.metrics,
    recommendedMemoryMaxMiB: final.recommendedMemoryMaxMiB,
  },
};
atomicWrite(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 0o600);
atomicWrite(
  memoryDropInPath,
  `[Service]\nMemoryMax=${final.recommendedMemoryMaxMiB}M\n`,
  0o600,
);

function sameHashes(record, components) {
  if (!record || !Array.isArray(components)) return false;
  const measured = Object.values(record).sort();
  const pinned = components.map((component) => component.sha256).sort();
  return JSON.stringify(measured) === JSON.stringify(pinned);
}

function atomicWrite(destination, content, mode) {
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(temporary, content, { mode, flag: 'wx' });
  renameSync(temporary, destination);
  chmodSync(destination, mode);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
