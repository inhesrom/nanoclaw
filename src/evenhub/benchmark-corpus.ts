import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { validateEvenHubPcm } from './wav.js';

export type CorpusNoise =
  | 'quiet'
  | 'tv_conversation'
  | 'outdoor_fan'
  | 'free_choice';
export type DurationBand = 'short' | 'medium' | 'long';

export interface BenchmarkSample {
  id: string;
  pcmPath: string;
  sha256: string;
  reference: string;
  intent: string;
  durationMs: number;
  noise: CorpusNoise;
  challengeTerms: boolean;
}

export interface BenchmarkManifest {
  version: 1;
  sessionId: string;
  createdAt: string;
  environment: {
    g2Firmware: string;
    evenHubApp: string;
    phone: string;
    pi: string;
    whisperCpp: string;
  };
  whisper: {
    endpoint: string;
    modelId: string;
    modelPath: string;
    binaryPath: string;
    threads: number;
    processors: number;
  };
  samples: BenchmarkSample[];
  corpusSha256: string;
}

export interface ValidatedManifest extends BenchmarkManifest {
  manifestPath: string;
}

const NOISES = new Set<CorpusNoise>([
  'quiet',
  'tv_conversation',
  'outdoor_fan',
  'free_choice',
]);

export function loadAndValidateManifest(
  manifestPath: string,
  projectRoot = process.cwd(),
): ValidatedManifest {
  const resolvedManifest = fs.realpathSync(path.resolve(manifestPath));
  const realProjectRoot = fs.realpathSync(path.resolve(projectRoot));
  assertOutsideProject(resolvedManifest, realProjectRoot, 'manifest');
  assertOwnerOnly(resolvedManifest, 'manifest');
  const parsed = JSON.parse(
    fs.readFileSync(resolvedManifest, 'utf8'),
  ) as BenchmarkManifest;
  validateManifestShape(parsed);

  const ids = new Set<string>();
  const pcmPaths = new Set<string>();
  const bands: Record<DurationBand, BenchmarkSample[]> = {
    short: [],
    medium: [],
    long: [],
  };
  const normalizedSamples: BenchmarkSample[] = [];

  for (const sample of parsed.samples) {
    if (!sample.id.trim() || ids.has(sample.id)) {
      throw new Error(`sample id is empty or duplicated: ${sample.id}`);
    }
    ids.add(sample.id);
    if (!path.isAbsolute(sample.pcmPath)) {
      throw new Error(`PCM path must be absolute for sample ${sample.id}`);
    }
    const pcmPath = fs.realpathSync(path.resolve(sample.pcmPath));
    assertOutsideProject(pcmPath, realProjectRoot, `PCM ${sample.id}`);
    assertOwnerOnly(pcmPath, `PCM ${sample.id}`);
    if (pcmPaths.has(pcmPath)) {
      throw new Error(`PCM path is duplicated for sample ${sample.id}`);
    }
    pcmPaths.add(pcmPath);
    if (!sample.reference.trim() || !sample.intent.trim()) {
      throw new Error(
        `reference and intent are required for sample ${sample.id}`,
      );
    }
    if (!NOISES.has(sample.noise)) {
      throw new Error(`invalid noise category for sample ${sample.id}`);
    }
    if (typeof sample.challengeTerms !== 'boolean') {
      throw new Error(`challengeTerms must be boolean for sample ${sample.id}`);
    }
    const pcm = fs.readFileSync(pcmPath);
    validateEvenHubPcm(pcm, sample.durationMs);
    const actualHash = sha256(pcm);
    if (actualHash !== sample.sha256) {
      throw new Error(`PCM checksum mismatch for sample ${sample.id}`);
    }
    bands[durationBand(sample.durationMs)].push(sample);
    normalizedSamples.push({ ...sample, pcmPath });
  }

  for (const [band, samples] of Object.entries(bands)) {
    if (samples.length !== 10) {
      throw new Error(`${band} duration band must contain exactly 10 samples`);
    }
    for (const noise of ['quiet', 'tv_conversation', 'outdoor_fan'] as const) {
      if (samples.filter((sample) => sample.noise === noise).length < 3) {
        throw new Error(
          `${band} duration band needs at least 3 ${noise} samples`,
        );
      }
    }
    if (!samples.some((sample) => sample.noise === 'free_choice')) {
      throw new Error(`${band} duration band needs one free_choice sample`);
    }
  }
  if (parsed.samples.filter((sample) => sample.challengeTerms).length < 10) {
    throw new Error('corpus needs at least 10 challenge-term samples');
  }
  const digest = corpusDigest(parsed.samples);
  if (digest !== parsed.corpusSha256) {
    throw new Error('aggregate corpus checksum mismatch');
  }

  return {
    ...parsed,
    whisper: {
      ...parsed.whisper,
      modelPath: fs.realpathSync(parsed.whisper.modelPath),
      binaryPath: fs.realpathSync(parsed.whisper.binaryPath),
    },
    samples: normalizedSamples,
    manifestPath: resolvedManifest,
  };
}

export function corpusDigest(samples: BenchmarkSample[]): string {
  const hash = createHash('sha256');
  for (const sample of samples) {
    hash.update(sample.id);
    hash.update('\0');
    hash.update(sample.sha256);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function durationBand(durationMs: number): DurationBand {
  if (durationMs >= 1_000 && durationMs <= 5_000) return 'short';
  if (durationMs >= 6_000 && durationMs <= 15_000) return 'medium';
  if (durationMs >= 16_000 && durationMs <= 30_000) return 'long';
  throw new Error(`duration ${durationMs}ms is outside the corpus bands`);
}

function validateManifestShape(manifest: BenchmarkManifest): void {
  if (manifest.version !== 1) throw new Error('manifest version must be 1');
  if (!manifest.sessionId?.trim()) throw new Error('sessionId is required');
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error('createdAt must be an ISO timestamp');
  }
  for (const [name, value] of Object.entries(manifest.environment ?? {})) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`environment.${name} is required`);
    }
  }
  const requiredEnvironment = [
    'g2Firmware',
    'evenHubApp',
    'phone',
    'pi',
    'whisperCpp',
  ];
  for (const name of requiredEnvironment) {
    if (!(name in (manifest.environment ?? {}))) {
      throw new Error(`environment.${name} is required`);
    }
  }
  if (!Array.isArray(manifest.samples) || manifest.samples.length !== 30) {
    throw new Error('manifest must contain exactly 30 samples');
  }
  const runtime = manifest.whisper;
  if (!runtime) throw new Error('whisper runtime metadata is required');
  const endpoint = new URL(runtime.endpoint);
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  ) {
    throw new Error('Whisper benchmark endpoint must be loopback HTTP');
  }
  if (!runtime.modelId?.trim()) throw new Error('whisper.modelId is required');
  for (const [name, value] of [
    ['modelPath', runtime.modelPath],
    ['binaryPath', runtime.binaryPath],
  ] as const) {
    if (!path.isAbsolute(value) || !fs.statSync(value).isFile()) {
      throw new Error(`whisper.${name} must be an absolute existing file`);
    }
  }
  if (runtime.threads !== 4 || runtime.processors !== 1) {
    throw new Error(
      'Whisper benchmark requires four threads and one processor',
    );
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.corpusSha256)) {
    throw new Error('corpusSha256 must be a SHA-256 digest');
  }
}

function assertOwnerOnly(file: string, description: string): void {
  const mode = fs.statSync(file).mode & 0o077;
  if (mode !== 0)
    throw new Error(`${description} must have owner-only permissions`);
}

function assertOutsideProject(
  candidate: string,
  projectRoot: string,
  description: string,
): void {
  const relative = path.relative(path.resolve(projectRoot), candidate);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    throw new Error(`${description} must be outside the git worktree`);
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
