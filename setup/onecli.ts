/**
 * Step: onecli — Install OneCLI, point it at the gateway, ensure an
 * Anthropic secret exists. Codifies the install and registration phases
 * of the /init-onecli skill so bootstrap can run them unattended.
 *
 * Flags:
 *   --onecli-url <url>   Gateway URL (falls back to .env, then platform default)
 *   --non-interactive    Never prompt; exit 5 when the secret is missing
 *
 * Env:
 *   NANOCLAW_ANTHROPIC_SECRET  Secret value for headless provisioning
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { getPlatform } from './platform.js';
import { emitStatus } from './status.js';

const LINUX_DEFAULT_URL = 'http://172.17.0.1:10254';

// The onecli installers drop binaries into ~/.local/bin, which may not be
// on PATH when this step runs standalone.
const execEnv = {
  ...process.env,
  PATH: `${process.env.PATH}:${path.join(os.homedir(), '.local', 'bin')}`,
};

function onecliWorks(): boolean {
  try {
    execSync('onecli version', { stdio: 'ignore', env: execEnv });
    return true;
  } catch {
    return false;
  }
}

function hasAnthropicSecret(): boolean {
  try {
    const out = execSync('onecli secrets list', {
      encoding: 'utf-8',
      env: execEnv,
    });
    return /anthropic/i.test(out);
  } catch {
    return false;
  }
}

async function gatewayHealthy(
  url: string,
  timeoutSec: number,
): Promise<boolean> {
  for (let i = 0; i < timeoutSec; i++) {
    // A 2xx from /health is the ideal signal, but not every gateway version
    // exposes that route. Any HTTP response — even a 404 — proves the gateway
    // process is up and serving; only a connection error means it's down.
    for (const probe of [`${url}/health`, url]) {
      try {
        const res = await fetch(probe, { signal: AbortSignal.timeout(2000) });
        if (res.ok || probe === url) return true;
      } catch {
        // Try the next probe / next iteration
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function writeEnvVar(key: string, value: string): void {
  const envFile = path.join(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    let content = fs.readFileSync(envFile, 'utf-8');
    if (new RegExp(`^${key}=`, 'm').test(content)) {
      content = content.replace(
        new RegExp(`^${key}=.*$`, 'm'),
        `${key}=${value}`,
      );
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
    fs.writeFileSync(envFile, content);
  } else {
    fs.writeFileSync(envFile, `${key}=${value}\n`);
  }
}

/** Read a line from stdin with echo disabled (for secrets). */
function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let input = '';
    const onData = (chunk: Buffer): void => {
      const c = chunk.toString('utf8');
      if (c === '\n' || c === '\r' || c === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(input.trim());
      } else if (c === '\u0003') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        reject(new Error('Interrupted'));
      } else if (c === '\u007f' || c === '\b') {
        input = input.slice(0, -1);
      } else {
        input += c;
      }
    };
    stdin.resume();
    stdin.setRawMode(true);
    stdin.on('data', onData);
  });
}

export async function run(args: string[]): Promise<void> {
  const nonInteractive = args.includes('--non-interactive');
  const urlFlagIdx = args.indexOf('--onecli-url');
  const urlFlag = urlFlagIdx !== -1 ? args[urlFlagIdx + 1] : undefined;
  const canPrompt = !nonInteractive && process.stdin.isTTY;

  // 1. Install (idempotent)
  let installed: 'already' | 'installed' = 'already';
  if (!onecliWorks()) {
    logger.info('OneCLI not found — running installers');
    console.log('Installing OneCLI gateway and CLI (from onecli.sh)...');
    execSync('curl -fsSL onecli.sh/install | sh', {
      stdio: 'inherit',
      env: execEnv,
    });
    execSync('curl -fsSL onecli.sh/cli/install | sh', {
      stdio: 'inherit',
      env: execEnv,
    });
    if (!onecliWorks()) {
      emitStatus('ONECLI', {
        STATUS: 'failed',
        ERROR:
          'onecli CLI not on PATH after install (expected in ~/.local/bin)',
      });
      process.exit(1);
    }
    installed = 'installed';
  }

  // 2. Resolve gateway URL: flag > .env > platform default
  let url = urlFlag || readEnvFile(['ONECLI_URL']).ONECLI_URL;
  if (!url) {
    if (getPlatform() === 'linux') {
      // Docker bridge gateway IP — reachable from both host and containers
      url = LINUX_DEFAULT_URL;
    } else if (canPrompt) {
      const { createInterface } = await import('readline/promises');
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      url = (
        await rl.question(
          'OneCLI gateway URL (printed by the installer above): ',
        )
      ).trim();
      rl.close();
    }
    if (!url) {
      emitStatus('ONECLI', {
        STATUS: 'needs_input',
        NEEDS_USER_INPUT: true,
        ERROR: 'No ONECLI_URL — pass --onecli-url or set it in .env',
      });
      process.exit(5);
    }
  }
  writeEnvVar('ONECLI_URL', url);
  execSync(`onecli config set api-host ${JSON.stringify(url)}`, {
    stdio: 'ignore',
    env: execEnv,
  });

  // 3. Gateway health — hard gate; without it containers get no credentials
  let healthy = await gatewayHealthy(url, 15);
  if (!healthy) {
    logger.warn({ url }, 'Gateway not responding — trying `onecli start`');
    try {
      execSync('onecli start', { stdio: 'inherit', env: execEnv });
    } catch {
      // Fall through to the re-poll
    }
    healthy = await gatewayHealthy(url, 15);
  }
  if (!healthy) {
    emitStatus('ONECLI', {
      ONECLI_URL: url,
      GATEWAY: 'unreachable',
      STATUS: 'failed',
      ERROR: `Gateway not healthy at ${url}/health — debug with \`onecli start\``,
    });
    process.exit(1);
  }

  // 4. Anthropic secret (the genuinely interactive gate)
  let secretState: 'present' | 'registered' = 'present';
  if (!hasAnthropicSecret()) {
    let secret = process.env.NANOCLAW_ANTHROPIC_SECRET?.trim();
    if (!secret && canPrompt) {
      console.log(
        '\nNanoClaw needs an Anthropic credential, stored in the OneCLI vault',
        '\n(agents never see the raw key).',
        '\nTip: run `claude setup-token` in another terminal for a subscription token,',
        '\nor use an API key from https://console.anthropic.com/settings/keys',
      );
      secret = await promptHidden(
        'Paste your Anthropic API key or OAuth token (input hidden): ',
      );
    }
    if (!secret) {
      emitStatus('ONECLI', {
        ONECLI_URL: url,
        GATEWAY: 'reachable',
        SECRET: 'missing',
        STATUS: 'needs_input',
        NEEDS_USER_INPUT: true,
        ERROR:
          'No Anthropic secret — set NANOCLAW_ANTHROPIC_SECRET or run interactively',
      });
      process.exit(5);
    }
    execFileSync(
      'onecli',
      [
        'secrets',
        'create',
        '--name',
        'Anthropic',
        '--type',
        'anthropic',
        '--value',
        secret,
        '--host-pattern',
        'api.anthropic.com',
      ],
      { stdio: ['ignore', 'ignore', 'inherit'], env: execEnv },
    );
    if (!hasAnthropicSecret()) {
      emitStatus('ONECLI', {
        ONECLI_URL: url,
        GATEWAY: 'reachable',
        SECRET: 'missing',
        STATUS: 'failed',
        ERROR:
          'Secret registration did not stick — check `onecli secrets list`',
      });
      process.exit(1);
    }
    secretState = 'registered';
  }

  logger.info({ url, installed, secretState }, 'OneCLI step complete');
  emitStatus('ONECLI', {
    ONECLI_INSTALL: installed,
    ONECLI_URL: url,
    GATEWAY: 'reachable',
    SECRET: secretState,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
