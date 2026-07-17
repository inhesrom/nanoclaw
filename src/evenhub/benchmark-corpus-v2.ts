import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  corpusDigest,
  durationBand,
  type BenchmarkSample,
  type CorpusNoise,
} from './benchmark-corpus.js';
import { validateEvenHubPcm } from './wav.js';

export interface BenchmarkManifestV2 {
  version: 2;
  sessionId: string;
  createdAt: string;
  environment: {
    g2Firmware: string;
    evenHubApp: string;
    phone: string;
    pi: string;
  };
  stt: {
    provider: string;
    streamingProtocol: string;
    serviceEndpoint: string;
    modelId: string;
    modelArchitecture: string;
    modelPath: string;
    runtimePath: string;
    modelComponents: string[];
    runtimeComponents: string[];
    lockfilePath: string;
    serverPath: string;
    updateIntervalMs: number;
  };
  samples: BenchmarkSample[];
  corpusSha256: string;
}

export interface ValidatedManifestV2 extends BenchmarkManifestV2 {
  manifestPath: string;
}

const NOISES = new Set<CorpusNoise>([
  'quiet',
  'tv_conversation',
  'outdoor_fan',
  'free_choice',
]);

export function loadAndValidateManifestV2(
  manifestPath: string,
  projectRoot = process.cwd(),
): ValidatedManifestV2 {
  const resolvedManifest = fs.realpathSync(path.resolve(manifestPath));
  const realProjectRoot = fs.realpathSync(path.resolve(projectRoot));
  assertOutsideProject(resolvedManifest, realProjectRoot, 'manifest');
  assertOwnerOnly(resolvedManifest, 'manifest');
  const parsed = JSON.parse(
    fs.readFileSync(resolvedManifest, 'utf8'),
  ) as BenchmarkManifestV2;
  validateShape(parsed);

  const ids = new Set<string>();
  const pcmPaths = new Set<string>();
  const bands = new Map<string, BenchmarkSample[]>([
    ['short', []],
    ['medium', []],
    ['long', []],
  ]);
  const samples = parsed.samples.map((sample) => {
    if (!sample.id?.trim() || ids.has(sample.id)) {
      throw new Error(`sample id is empty or duplicated: ${sample.id}`);
    }
    ids.add(sample.id);
    if (!path.isAbsolute(sample.pcmPath)) {
      throw new Error(`PCM path must be absolute for sample ${sample.id}`);
    }
    const pcmPath = fs.realpathSync(sample.pcmPath);
    assertOutsideProject(pcmPath, realProjectRoot, `PCM ${sample.id}`);
    assertOwnerOnly(pcmPath, `PCM ${sample.id}`);
    if (pcmPaths.has(pcmPath)) throw new Error('PCM paths must be unique');
    pcmPaths.add(pcmPath);
    if (!sample.reference?.trim() || !sample.intent?.trim()) {
      throw new Error(`reference and intent are required for ${sample.id}`);
    }
    if (!NOISES.has(sample.noise)) throw new Error('invalid noise category');
    if (typeof sample.challengeTerms !== 'boolean') {
      throw new Error('challengeTerms must be boolean');
    }
    const pcm = fs.readFileSync(pcmPath);
    validateEvenHubPcm(pcm, sample.durationMs);
    if (sha256(pcm) !== sample.sha256) throw new Error('PCM checksum mismatch');
    bands.get(durationBand(sample.durationMs))!.push(sample);
    return { ...sample, pcmPath };
  });
  for (const [band, items] of bands) {
    if (items.length !== 10) throw new Error(`${band} band needs 10 samples`);
    for (const noise of ['quiet', 'tv_conversation', 'outdoor_fan'] as const) {
      if (items.filter((sample) => sample.noise === noise).length < 3) {
        throw new Error(`${band} band needs at least 3 ${noise} samples`);
      }
    }
    if (!items.some((sample) => sample.noise === 'free_choice')) {
      throw new Error(`${band} band needs one free_choice sample`);
    }
  }
  if (samples.filter((sample) => sample.challengeTerms).length < 10) {
    throw new Error('corpus needs at least 10 challenge-term samples');
  }
  if (corpusDigest(samples) !== parsed.corpusSha256) {
    throw new Error('aggregate corpus checksum mismatch');
  }

  return {
    ...parsed,
    stt: {
      ...parsed.stt,
      modelPath: realDirectory(parsed.stt.modelPath, 'modelPath'),
      runtimePath: realDirectory(parsed.stt.runtimePath, 'runtimePath'),
      modelComponents: parsed.stt.modelComponents.map((candidate) =>
        realFile(candidate, 'model component'),
      ),
      runtimeComponents: parsed.stt.runtimeComponents.map((candidate) =>
        realFile(candidate, 'runtime component'),
      ),
      lockfilePath: realFile(parsed.stt.lockfilePath, 'lockfilePath'),
      serverPath: realFile(parsed.stt.serverPath, 'serverPath'),
    },
    samples,
    manifestPath: resolvedManifest,
  };
}

function validateShape(manifest: BenchmarkManifestV2): void {
  if (manifest.version !== 2) throw new Error('manifest version must be 2');
  if (!manifest.sessionId?.trim()) throw new Error('sessionId is required');
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error('createdAt must be an ISO timestamp');
  }
  for (const name of ['g2Firmware', 'evenHubApp', 'phone', 'pi'] as const) {
    if (!manifest.environment?.[name]?.trim()) {
      throw new Error(`environment.${name} is required`);
    }
  }
  if (!Array.isArray(manifest.samples) || manifest.samples.length !== 30) {
    throw new Error('manifest must contain exactly 30 samples');
  }
  const stt = manifest.stt;
  for (const name of [
    'provider',
    'streamingProtocol',
    'modelId',
    'modelArchitecture',
  ] as const) {
    if (!stt?.[name]?.trim()) throw new Error(`stt.${name} is required`);
  }
  const endpoint = new URL(stt.serviceEndpoint);
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.port !== '8178' ||
    endpoint.pathname !== '/' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('STT benchmark endpoint must be http://127.0.0.1:8178');
  }
  if (stt.updateIntervalMs !== 500) {
    throw new Error('streaming update interval must be 500ms');
  }
  if (!stt.modelComponents?.length || !stt.runtimeComponents?.length) {
    throw new Error('model and runtime component paths are required');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.corpusSha256)) {
    throw new Error('corpusSha256 must be SHA-256');
  }
}

function realDirectory(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be absolute`);
  const resolved = fs.realpathSync(candidate);
  if (!fs.statSync(resolved).isDirectory())
    throw new Error(`${label} must be a directory`);
  return resolved;
}

function realFile(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be absolute`);
  const resolved = fs.realpathSync(candidate);
  if (!fs.statSync(resolved).isFile())
    throw new Error(`${label} must be a file`);
  return resolved;
}

function assertOwnerOnly(candidate: string, label: string): void {
  if ((fs.statSync(candidate).mode & 0o077) !== 0) {
    throw new Error(`${label} must have owner-only permissions`);
  }
}

function assertOutsideProject(
  candidate: string,
  project: string,
  label: string,
): void {
  const relative = path.relative(project, candidate);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    throw new Error(`${label} must be outside the git worktree`);
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
