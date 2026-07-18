import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const evenhubRoot = path.resolve(scriptDir, '..');
export const templatePath = path.join(evenhubRoot, 'app.template.json');
export const privateEnvPath = path.join(evenhubRoot, '.env.private');
export const distPath = path.join(evenhubRoot, 'dist');
export const cliPath = path.join(
  evenhubRoot,
  'node_modules',
  '.bin',
  'evenhub',
);
export const exampleOrigin = 'https://nanoclaw.example.ts.net';

export function validateTailnetOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('EVENHUB_ORIGIN is required');
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('EVENHUB_ORIGIN must be a canonical HTTPS ts.net origin', {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.origin !== value ||
    !url.hostname.endsWith('.ts.net') ||
    url.hostname.split('.').length < 4
  ) {
    throw new Error('EVENHUB_ORIGIN must be a canonical HTTPS ts.net origin');
  }
  return value;
}

export function readPrivateOrigin(filePath = privateEnvPath) {
  const mode = statSync(filePath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${filePath} must not be accessible by group or other users`,
    );
  }
  const values = new Map();
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1)
      throw new Error(`invalid private config line: ${rawLine}`);
    const key = line.slice(0, separator);
    if (key !== 'EVENHUB_ORIGIN' || values.has(key)) {
      throw new Error('private config must contain exactly one EVENHUB_ORIGIN');
    }
    values.set(key, line.slice(separator + 1));
  }
  if (values.size !== 1) {
    throw new Error('private config must contain exactly one EVENHUB_ORIGIN');
  }
  return validateTailnetOrigin(values.get('EVENHUB_ORIGIN'));
}

export function renderPrivateManifest(origin, outputPath) {
  const approvedOrigin = validateTailnetOrigin(origin);
  const template = readFileSync(templatePath, 'utf8');
  const manifest = JSON.parse(template);
  const network = manifest.permissions?.find(({ name }) => name === 'network');
  if (!network)
    throw new Error('manifest template is missing network permission');
  const exampleWebSocketOrigin = exampleOrigin.replace(/^https:/, 'wss:');
  if (
    JSON.stringify(network.whitelist) !==
    JSON.stringify([exampleOrigin, exampleWebSocketOrigin])
  ) {
    throw new Error('manifest template has an unexpected network whitelist');
  }
  const rendered = template
    .replaceAll(exampleOrigin, approvedOrigin)
    .replaceAll(
      exampleWebSocketOrigin,
      approvedOrigin.replace(/^https:/, 'wss:'),
    );
  const renderedManifest = JSON.parse(rendered);
  writeFileSync(outputPath, rendered, { mode: 0o600 });
  return renderedManifest;
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(entryPath) : [entryPath];
  });
}

export function buildPrivateClient(origin) {
  const approvedOrigin = validateTailnetOrigin(origin);
  rmSync(distPath, { recursive: true, force: true });
  execFileSync('npm', ['run', 'build'], {
    cwd: evenhubRoot,
    env: { ...process.env, VITE_EVENHUB_ORIGIN: approvedOrigin },
    stdio: 'inherit',
  });
  const bundleContainsOrigin = filesBelow(distPath).some((filePath) =>
    readFileSync(filePath).includes(Buffer.from(approvedOrigin)),
  );
  if (!bundleContainsOrigin) {
    throw new Error('built client does not contain the private origin');
  }
}

export function packPrivateManifest(manifestPath, outputPath) {
  execFileSync(cliPath, ['pack', '-o', outputPath, manifestPath, distPath], {
    cwd: evenhubRoot,
    stdio: 'inherit',
  });
  chmodSync(outputPath, 0o600);
}

export function buildPrivatePackages(
  origin,
  manifestPath,
  outputPaths,
  { buildClient = buildPrivateClient, packManifest = packPrivateManifest } = {},
) {
  const approvedOrigin = validateTailnetOrigin(origin);
  for (const outputPath of outputPaths) {
    buildClient(approvedOrigin);
    packManifest(manifestPath, outputPath);
  }
}
