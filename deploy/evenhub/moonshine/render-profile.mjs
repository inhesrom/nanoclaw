#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const [
  modelPath,
  runtimePath,
  serverPath,
  lockPath,
  outputPath,
  status = 'candidate',
] = process.argv.slice(2);
if (!modelPath || !runtimePath || !serverPath || !lockPath || !outputPath) {
  throw new Error(
    'usage: render-profile MODEL RUNTIME SERVER LOCK OUTPUT [candidate]',
  );
}
if (status !== 'candidate') {
  throw new Error(
    'render-profile only creates candidates; use select-profile.mjs with passing evidence',
  );
}

const expectedComponents = [
  'adapter.ort',
  'cross_kv.ort',
  'decoder_kv.ort',
  'decoder_kv_with_attention.ort',
  'encoder.ort',
  'frontend.ort',
  'streaming_config.json',
  'tokenizer.bin',
];
const components = expectedComponents.map((name) => {
  const candidate = path.join(modelPath, name);
  if (!statSync(candidate).isFile())
    throw new Error(`missing model component: ${name}`);
  return {
    path: name,
    sha256: sha256(candidate),
    bytes: statSync(candidate).size,
  };
});
const pythonDirectories = readdirSync(path.join(runtimePath, 'lib'), {
  withFileTypes: true,
})
  .filter((entry) => {
    if (!entry.isDirectory() || !/^python\d+\.\d+$/.test(entry.name)) {
      return false;
    }
    try {
      return statSync(
        path.join(runtimePath, 'lib', entry.name, 'site-packages'),
      ).isDirectory();
    } catch {
      return false;
    }
  })
  .map((entry) => entry.name);
if (pythonDirectories.length !== 1) {
  throw new Error(
    'runtime must contain exactly one Python site-packages directory',
  );
}
const pythonDirectory = pythonDirectories[0];
const sitePackages = path.join(
  runtimePath,
  'lib',
  pythonDirectory,
  'site-packages',
);
const runtimeComponents = walk(sitePackages)
  .filter((candidate) =>
    /(?:\.so(?:\..*)?|\.dist-info\/(?:RECORD|LICENSE[^/]*|licenses\/.*))$/i.test(
      candidate,
    ),
  )
  .map((candidate) => ({
    path: path.relative(runtimePath, candidate),
    sha256: sha256(candidate),
    bytes: statSync(candidate).size,
  }));
if (!runtimeComponents.some((item) => item.path.endsWith('libmoonshine.so'))) {
  throw new Error('Moonshine native library was not found in the runtime');
}

const profile = {
  version: 1,
  selectionStatus: status,
  provider: 'moonshine',
  runtimeVersion: '0.0.69',
  pythonVersion: pythonDirectory.slice('python'.length),
  runtimePath,
  runtimeLockPath: lockPath,
  runtimeLockSha256: sha256(lockPath),
  serverPath,
  serverSha256: sha256(serverPath),
  modelId: 'moonshine-streaming-small-en',
  modelPath,
  modelArch: 4,
  modelArchitecture: 'small-streaming',
  updateIntervalMs: 500,
  serviceEndpoint: 'http://127.0.0.1:8178',
  components,
  runtimeComponents,
  evidence: null,
};
const temporary = `${outputPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
  mode: 0o600,
  flag: 'wx',
});
renameSync(temporary, outputPath);
chmodSync(outputPath, 0o600);

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(candidate));
    else if (entry.isFile()) result.push(candidate);
  }
  return result;
}

function sha256(candidate) {
  return createHash('sha256').update(readFileSync(candidate)).digest('hex');
}
