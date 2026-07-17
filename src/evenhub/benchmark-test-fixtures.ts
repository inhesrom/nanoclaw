import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  corpusDigest,
  type BenchmarkManifest,
  type BenchmarkSample,
  type CorpusNoise,
} from './benchmark-corpus.js';
import type { BenchmarkManifestV2 } from './benchmark-corpus-v2.js';

export function createBenchmarkFixture(root: string): {
  manifest: BenchmarkManifest;
  manifestPath: string;
  projectRoot: string;
} {
  const projectRoot = path.join(root, 'repo');
  const corpusDir = path.join(root, 'corpus');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(corpusDir, { mode: 0o700 });
  const noises: CorpusNoise[] = [
    'quiet',
    'quiet',
    'quiet',
    'tv_conversation',
    'tv_conversation',
    'tv_conversation',
    'outdoor_fan',
    'outdoor_fan',
    'outdoor_fan',
    'free_choice',
  ];
  const durations = [1_000, 6_000, 16_000];
  const samples: BenchmarkSample[] = [];
  for (let band = 0; band < durations.length; band += 1) {
    for (let index = 0; index < 10; index += 1) {
      const id = `${['short', 'medium', 'long'][band]}-${index + 1}`;
      const pcm = Buffer.alloc(durations[band] * 32);
      pcm.writeInt16LE(band * 100 + index, 0);
      const pcmPath = path.join(corpusDir, `${id}.pcm`);
      fs.writeFileSync(pcmPath, pcm, { mode: 0o600 });
      samples.push({
        id,
        pcmPath,
        sha256: createHash('sha256').update(pcm).digest('hex'),
        reference: `send sample ${band} number ${index}`,
        intent: `Send sample ${band}, number ${index}`,
        durationMs: durations[band],
        noise: noises[index],
        challengeTerms: samples.length < 10,
      });
    }
  }
  const modelPath = path.join(root, 'ggml-base.en.bin');
  const binaryPath = path.join(root, 'whisper-server');
  fs.writeFileSync(modelPath, 'model', { mode: 0o600 });
  fs.writeFileSync(binaryPath, 'binary', { mode: 0o700 });
  const manifest: BenchmarkManifest = {
    version: 1,
    sessionId: '2026-07-16T00-00-00Z',
    createdAt: '2026-07-16T00:00:00.000Z',
    environment: {
      g2Firmware: 'test-g2',
      evenHubApp: 'test-app',
      phone: 'test-phone',
      pi: 'test-pi',
      whisperCpp: 'v1.9.1',
    },
    whisper: {
      endpoint: 'http://127.0.0.1:8178/inference',
      modelId: 'base.en',
      modelPath,
      binaryPath,
      threads: 4,
      processors: 1,
    },
    samples,
    corpusSha256: corpusDigest(samples),
  };
  const manifestPath = path.join(corpusDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { manifest, manifestPath, projectRoot };
}

export function createBenchmarkFixtureV2(root: string): {
  manifest: BenchmarkManifestV2;
  manifestPath: string;
  projectRoot: string;
} {
  const v1 = createBenchmarkFixture(root);
  const modelPath = path.join(root, 'moonshine-model');
  const runtimePath = path.join(root, 'moonshine-runtime');
  fs.mkdirSync(modelPath, { mode: 0o700 });
  fs.mkdirSync(runtimePath, { mode: 0o700 });
  const modelComponent = path.join(modelPath, 'encoder.ort');
  const runtimeComponent = path.join(runtimePath, 'libmoonshine.so');
  const lockfilePath = path.join(root, 'requirements.lock');
  const serverPath = path.join(root, 'moonshine-server.py');
  fs.writeFileSync(modelComponent, 'model-v2', { mode: 0o600 });
  fs.writeFileSync(runtimeComponent, 'runtime-v2', { mode: 0o600 });
  fs.writeFileSync(lockfilePath, 'lock-v2', { mode: 0o600 });
  fs.writeFileSync(serverPath, 'server-v2', { mode: 0o600 });
  const manifest: BenchmarkManifestV2 = {
    version: 2,
    sessionId: v1.manifest.sessionId,
    createdAt: v1.manifest.createdAt,
    environment: {
      g2Firmware: 'test-g2',
      evenHubApp: '0.2.1',
      phone: 'test-phone',
      pi: 'test-pi',
    },
    stt: {
      provider: 'moonshine',
      streamingProtocol: 'nanoclaw-stt-v1',
      serviceEndpoint: 'http://127.0.0.1:8178',
      modelId: 'moonshine-streaming-small-en',
      modelArchitecture: 'small-streaming',
      modelPath,
      runtimePath,
      modelComponents: [modelComponent],
      runtimeComponents: [runtimeComponent],
      lockfilePath,
      serverPath,
      updateIntervalMs: 500,
    },
    samples: v1.manifest.samples,
    corpusSha256: v1.manifest.corpusSha256,
  };
  const manifestPath = v1.manifestPath;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { manifest, manifestPath, projectRoot: v1.projectRoot };
}
