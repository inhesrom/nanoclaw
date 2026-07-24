/**
 * Step: bootstrap — Non-interactive orchestrator that chains the existing
 * setup steps into a single clean-clone → running-service run.
 *
 * Invoked by bootstrap.sh once Node, Docker, and dependencies are in place:
 *   npx tsx setup/index.ts --step bootstrap -- <flags>
 *
 * Each sub-step runs as its own `npx tsx setup/index.ts --step <name>`
 * subprocess. Steps call process.exit() mid-flow, so spawning (rather than
 * importing) preserves their exit-code + status-block contract — the same one
 * the /setup skill already relies on.
 *
 * Interactive gates (OneCLI secret, WhatsApp QR) come BEFORE the multi-minute
 * container build so the user isn't summoned back to a stale QR.
 *
 * Flags:
 *   --non-interactive        Never prompt; exit 5 at any unmet gate
 *   --runtime <docker>       Container runtime (only docker supported here)
 *   --tz <IANA>              Timezone (else autodetected)
 *   --onecli-url <url>       OneCLI gateway URL
 *   --phone <number>         WhatsApp pairing-code mode (E.164, no +)
 *   --assistant-name <name>  Assistant name (else .env ASSISTANT_NAME)
 *   --main-jid <jid>         Override derived main-channel JID
 *   --skip-register          Skip main-channel registration
 *   --skip-service           Skip service install/start
 *   --rebuild                Rebuild the agent image even if it exists
 *   --with-evenhub           Run the EvenHub installer after verify
 *
 * Env: NANOCLAW_ANTHROPIC_SECRET (forwarded to the onecli step)
 *
 * Exit codes: 0 success · 1 step failure · 2 missing prerequisite ·
 *             5 gate unmet in --non-interactive mode
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { getPlatform, isRoot } from './platform.js';
import { emitStatus, parseStatusBlock } from './status.js';

const AGENT_IMAGE = 'nanoclaw-agent:latest';

interface Flags {
  nonInteractive: boolean;
  runtime: string;
  tz?: string;
  onecliUrl?: string;
  phone?: string;
  assistantName?: string;
  mainJid?: string;
  skipRegister: boolean;
  skipService: boolean;
  rebuild: boolean;
  withEvenhub: boolean;
}

function parseFlags(args: string[]): Flags {
  const val = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    nonInteractive: args.includes('--non-interactive'),
    runtime: val('--runtime') || 'docker',
    tz: val('--tz'),
    onecliUrl: val('--onecli-url'),
    phone: val('--phone'),
    assistantName: val('--assistant-name'),
    mainJid: val('--main-jid'),
    skipRegister: args.includes('--skip-register'),
    skipService: args.includes('--skip-service'),
    rebuild: args.includes('--rebuild'),
    withEvenhub: args.includes('--with-evenhub'),
  };
}

type StepResult =
  | { code: number; fields: Record<string, string> | null }
  | { code: number; fields: null };

/** Run a setup step, capturing its status block. */
function runStepCaptured(name: string, stepArgs: string[] = []): StepResult {
  const res = spawnSync(
    'npx',
    ['tsx', 'setup/index.ts', '--step', name, '--', ...stepArgs],
    { encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'] },
  );
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.stdout) process.stdout.write(res.stdout);
  return { code: res.status ?? 1, fields: parseStatusBlock(out) };
}

/** Run a step (or arbitrary command) with inherited stdio for interactivity. */
function runInteractive(cmd: string, cmdArgs: string[]): number {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
  return res.status ?? 1;
}

function tailSetupLog(lines = 20): string {
  const logPath = path.join(process.cwd(), 'logs', 'setup.log');
  try {
    const all = fs.readFileSync(logPath, 'utf-8').trimEnd().split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '(logs/setup.log not available)';
  }
}

function fail(step: string, code: number, hint: string): never {
  console.error(`\n✗ Bootstrap failed at step: ${step}`);
  console.error(hint);
  console.error('\nRecent logs/setup.log:');
  console.error(tailSetupLog());
  console.error(
    '\nFix the issue and re-run ./bootstrap.sh — completed steps will be skipped.',
  );
  emitStatus('BOOTSTRAP_ALL', {
    FAILED_STEP: step,
    STATUS: 'failed',
    EXIT_CODE: code,
  });
  process.exit(code);
}

function agentImageExists(): boolean {
  const res = spawnSync('docker', ['image', 'inspect', AGENT_IMAGE], {
    stdio: 'ignore',
  });
  return res.status === 0;
}

function readMainCredsJid(): string | undefined {
  const credsPath = path.join(STORE_DIR, 'auth', 'creds.json');
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    const id: string | undefined = creds?.me?.id;
    if (id) return `${id.split(':')[0]}@s.whatsapp.net`;
  } catch {
    // No creds yet
  }
  return undefined;
}

function hasWhatsAppAuth(): boolean {
  return fs.existsSync(path.join(STORE_DIR, 'auth', 'creds.json'));
}

function queryCount(sql: string): number {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(sql).get() as { count: number } | undefined;
    db.close();
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export async function run(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const platform = getPlatform();
  const summary: Record<string, string> = {};

  if (isRoot()) {
    // Root would install a system-wide service and root-owned config; the whole
    // fork is designed to run as an unprivileged user. EvenHub is the only part
    // that legitimately needs root, and it re-elevates on its own.
    console.error(
      'Do not run bootstrap as root. Run it as your normal user;\n' +
        'the EvenHub installer will ask for sudo when needed.',
    );
    process.exit(2);
  }

  if (flags.runtime !== 'docker') {
    fail(
      'preflight',
      2,
      `Runtime "${flags.runtime}" is not supported by bootstrap. ` +
        'Use Docker, or run /setup + /convert-to-apple-container for Apple Container.',
    );
  }

  console.log('\n=== NanoClaw bootstrap ===\n');

  // 1. Environment detection ------------------------------------------------
  console.log('› Detecting environment...');
  const env = runStepCaptured('environment');
  if (env.code !== 0) fail('environment', 1, 'Environment detection failed.');
  if (env.fields?.DOCKER && env.fields.DOCKER !== 'running') {
    fail(
      'environment',
      2,
      'Docker is not running. bootstrap.sh should have started it — ' +
        'start Docker and re-run.',
    );
  }
  summary.ENVIRONMENT = 'ok';

  // 2. Timezone -------------------------------------------------------------
  console.log('› Resolving timezone...');
  let tz = runStepCaptured('timezone', flags.tz ? ['--tz', flags.tz] : []);
  if (tz.fields?.NEEDS_USER_INPUT === 'true') {
    if (flags.nonInteractive) {
      console.warn(
        '⚠ Could not autodetect timezone; continuing without TZ. ' +
          'Pass --tz <IANA> to set it.',
      );
    } else {
      const { createInterface } = await import('readline/promises');
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = (
        await rl.question('Enter your timezone (e.g. America/Denver): ')
      ).trim();
      rl.close();
      if (answer) tz = runStepCaptured('timezone', ['--tz', answer]);
    }
  }
  summary.TIMEZONE = tz.fields?.RESOLVED_TZ || 'unset';

  // 3. OneCLI (interactive gate: Anthropic secret) --------------------------
  console.log('› Configuring OneCLI credential gateway...');
  const onecliArgs = ['tsx', 'setup/index.ts', '--step', 'onecli', '--'];
  if (flags.onecliUrl) onecliArgs.push('--onecli-url', flags.onecliUrl);
  if (flags.nonInteractive) onecliArgs.push('--non-interactive');
  const onecliCode = runInteractive('npx', onecliArgs);
  if (onecliCode !== 0) {
    fail(
      'onecli',
      onecliCode === 5 ? 5 : 1,
      onecliCode === 5
        ? 'OneCLI needs an Anthropic secret. Set NANOCLAW_ANTHROPIC_SECRET ' +
            'or run without --non-interactive.'
        : 'OneCLI setup failed (install, gateway health, or secret).',
    );
  }
  summary.ONECLI = 'ok';

  // 4. WhatsApp auth (interactive gate: QR / pairing code) ------------------
  let freshAuth = false;
  if (hasWhatsAppAuth()) {
    console.log('› WhatsApp already authenticated — skipping.');
    summary.WHATSAPP = 'skipped';
  } else if (flags.nonInteractive) {
    fail(
      'whatsapp-auth',
      5,
      'WhatsApp authentication is interactive (QR / pairing code) and cannot ' +
        'run with --non-interactive. Re-run interactively, or copy an existing ' +
        'store/auth directory onto this machine first.',
    );
  } else {
    console.log(
      '› Authenticating WhatsApp. A QR code will appear — open WhatsApp →\n' +
        '  Settings → Linked Devices → Link a Device. If the QR does not render,\n' +
        '  the raw value is written to store/qr-data.txt.\n',
    );
    const waArgs = ['tsx', 'src/whatsapp-auth.ts'];
    if (flags.phone) waArgs.push('--pairing-code', '--phone', flags.phone);
    let attempts = 0;
    let code = runInteractive('npx', waArgs);
    while (code !== 0 && attempts < 2) {
      attempts++;
      const { createInterface } = await import('readline/promises');
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const retry = (
        await rl.question(`WhatsApp auth failed. Retry? (${attempts}/2) [Y/n] `)
      )
        .trim()
        .toLowerCase();
      rl.close();
      if (retry === 'n') break;
      code = runInteractive('npx', waArgs);
    }
    if (code !== 0) {
      fail('whatsapp-auth', 1, 'WhatsApp authentication did not complete.');
    }
    freshAuth = true;
    summary.WHATSAPP = 'authenticated';
  }

  // 5. Container image ------------------------------------------------------
  if (!flags.rebuild && agentImageExists()) {
    console.log(`› Agent image ${AGENT_IMAGE} exists — skipping build.`);
    summary.CONTAINER = 'skipped';
  } else {
    console.log(
      '› Building agent container image (first build takes several minutes)...',
    );
    const c = runStepCaptured('container', ['--runtime', flags.runtime]);
    if (c.code !== 0) {
      fail('container', c.code === 2 ? 2 : 1, 'Container image build failed.');
    }
    summary.CONTAINER = 'built';
  }

  // 6. Group sync (WhatsApp only; best-effort) ------------------------------
  if (
    freshAuth ||
    (hasWhatsAppAuth() &&
      queryCount(
        "SELECT COUNT(*) as count FROM chats WHERE jid LIKE '%@g.us' AND jid <> '__group_sync__'",
      ) === 0)
  ) {
    console.log('› Syncing WhatsApp groups...');
    const g = runStepCaptured('groups');
    // Non-fatal: a main self-chat install works without group metadata.
    summary.GROUPS =
      g.code === 0 ? g.fields?.SYNC || 'ok' : 'failed (non-fatal)';
    if (g.code !== 0) {
      console.warn(
        '⚠ Group sync failed — continuing (not required for setup).',
      );
    }
  } else {
    summary.GROUPS = 'skipped';
  }

  // 7. Register main channel ------------------------------------------------
  const mainRegistered =
    queryCount(
      'SELECT COUNT(*) as count FROM registered_groups WHERE is_main = 1',
    ) > 0;
  if (flags.skipRegister) {
    summary.REGISTER = 'skipped (--skip-register)';
  } else if (mainRegistered) {
    console.log('› Main channel already registered — skipping.');
    summary.REGISTER = 'skipped';
  } else {
    const jid = flags.mainJid || readMainCredsJid();
    if (!jid) {
      console.warn(
        '⚠ No WhatsApp credentials and no --main-jid — skipping registration. ' +
          'Register later with `npx tsx setup/index.ts --step register`.',
      );
      summary.REGISTER = 'skipped (no jid)';
    } else {
      const assistantName =
        flags.assistantName ||
        readEnvFile(['ASSISTANT_NAME']).ASSISTANT_NAME ||
        'Andy';
      console.log(`› Registering main channel (${jid})...`);
      const r = runStepCaptured('register', [
        '--jid',
        jid,
        '--name',
        'Self-chat',
        '--trigger',
        `@${assistantName}`,
        '--folder',
        'whatsapp_main',
        '--channel',
        'whatsapp',
        '--assistant-name',
        assistantName,
        '--is-main',
        '--no-trigger-required',
      ]);
      if (r.code !== 0)
        fail('register', 1, 'Main channel registration failed.');
      summary.REGISTER = 'registered';
    }
  }

  // 8. Mount allowlist ------------------------------------------------------
  console.log('› Writing mount allowlist...');
  const m = runStepCaptured('mounts', ['--empty']);
  if (m.code !== 0) fail('mounts', 1, 'Mount allowlist configuration failed.');
  summary.MOUNTS = m.fields?.STATUS === 'skipped' ? 'exists' : 'written';

  // 9. Service --------------------------------------------------------------
  if (flags.skipService) {
    summary.SERVICE = 'skipped (--skip-service)';
  } else {
    // Stop any running instance first: setup/service.ts uses `start` (not
    // `restart`), so a live service would keep running the pre-build code.
    if (platform === 'linux') {
      spawnSync('systemctl', ['--user', 'stop', 'nanoclaw'], {
        stdio: 'ignore',
      });
    }
    console.log('› Installing and starting the service...');
    const s = runStepCaptured('service');
    if (s.code !== 0) fail('service', 1, 'Service installation failed.');
    summary.SERVICE =
      s.fields?.SERVICE_LOADED === 'true' ? 'running' : 'installed';
  }

  // 10. Verify --------------------------------------------------------------
  console.log('› Verifying installation...');
  const v = runStepCaptured('verify');
  summary.VERIFY = v.fields?.STATUS || 'unknown';

  // 11. EvenHub hook --------------------------------------------------------
  let runEvenhub = flags.withEvenhub;
  if (!runEvenhub && !flags.nonInteractive) {
    const { createInterface } = await import('readline/promises');
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ans = (
      await rl.question('Set up the EvenHub voice stack now? [y/N] ')
    )
      .trim()
      .toLowerCase();
    rl.close();
    runEvenhub = ans === 'y' || ans === 'yes';
  }
  if (runEvenhub) {
    const installer = path.join(
      process.cwd(),
      'deploy',
      'evenhub',
      'install.sh',
    );
    if (fs.existsSync(installer)) {
      console.log('› Launching EvenHub installer (requires sudo)...');
      const code = runInteractive('sudo', ['bash', installer]);
      summary.EVENHUB = code === 0 ? 'installed' : `failed (${code})`;
    } else {
      console.warn(
        `⚠ EvenHub installer not found at ${installer} — ` +
          'see docs/evenhub-tailscale-deployment.md.',
      );
      summary.EVENHUB = 'installer_missing';
    }
  } else {
    summary.EVENHUB = 'skipped';
  }

  // Summary -----------------------------------------------------------------
  emitStatus('BOOTSTRAP_ALL', {
    ...summary,
    STATUS: v.fields?.STATUS === 'success' ? 'success' : 'partial',
    LOG: 'logs/setup.log',
  });

  console.log('\n=== Bootstrap complete ===');
  if (v.fields?.STATUS === 'success') {
    console.log(
      'Send yourself a WhatsApp message and watch:  tail -f logs/nanoclaw.log\n' +
        'You should see "OneCLI gateway config applied" and an agent reply.',
    );
  } else {
    console.log(
      'Some checks did not pass — review the VERIFY block above and ' +
        'logs/nanoclaw.log. Re-run ./bootstrap.sh to resume.',
    );
  }
}
