import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR, ONECLI_URL } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

export const GOOGLE_AUTH_POLL_MS = 15 * 60 * 1000;
export const GOOGLE_AUTH_INITIAL_DELAY_MS = 60_000;
export const GOOGLE_AUTH_STATE_PATH = path.join(
  DATA_DIR,
  'google-auth-status.json',
);

const CHECK_SCRIPT = path.resolve(
  process.cwd(),
  'scripts/check-google-auth.sh',
);

export interface ServiceState {
  ok: boolean;
  httpStatus: number;
}

export interface AuthSnapshot {
  checkedAt: string;
  services: Record<string, ServiceState>;
  hint?: string;
}

export interface AuthDiff {
  down: string[];
  recovered: string[];
}

export interface GoogleAuthMonitorDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  getAlertJid: () => string | undefined;
  runProbe?: () => Promise<AuthSnapshot>;
  now?: () => Date;
  statePath?: string;
  intervalMs?: number;
  initialDelayMs?: number;
}

let stopMonitor: (() => void) | undefined;

export function parseAuthProbeJson(raw: string): AuthSnapshot {
  const line = raw
    .trim()
    .split('\n')
    .filter((entry) => entry.trim().startsWith('{'))
    .pop();
  if (!line) {
    throw new Error('Auth probe produced no JSON');
  }
  const parsed = JSON.parse(line) as {
    data?: {
      ok?: boolean;
      services?: Record<string, ServiceState> | string[];
      hint?: string;
    };
    services?: Record<string, ServiceState>;
    hint?: string;
  };
  const servicesRaw = parsed.data?.services ?? parsed.services;
  const services: Record<string, ServiceState> = {};
  if (Array.isArray(servicesRaw)) {
    for (const name of servicesRaw) {
      services[name] = { ok: true, httpStatus: 200 };
    }
  } else if (servicesRaw && typeof servicesRaw === 'object') {
    for (const [name, state] of Object.entries(servicesRaw)) {
      services[name] = {
        ok: Boolean(state?.ok),
        httpStatus: Number(state?.httpStatus) || 0,
      };
    }
  }
  if (Object.keys(services).length === 0) {
    throw new Error('Auth probe JSON had no services');
  }
  return {
    checkedAt: new Date().toISOString(),
    services,
    hint: parsed.data?.hint ?? parsed.hint,
  };
}

export function diffAuthSnapshots(
  previous: AuthSnapshot | null,
  next: AuthSnapshot,
): AuthDiff {
  const down: string[] = [];
  const recovered: string[] = [];
  for (const [name, state] of Object.entries(next.services)) {
    const wasOk = previous?.services[name]?.ok;
    if (state.ok) {
      if (wasOk === false) recovered.push(name);
    } else if (wasOk !== false) {
      down.push(name);
    }
  }
  if (previous) {
    for (const name of Object.keys(previous.services)) {
      if (!(name in next.services)) down.push(name);
    }
  }
  return { down, recovered };
}

export function formatAuthAlert(
  diff: AuthDiff,
  snapshot: AuthSnapshot,
): string {
  const lines: string[] = [];
  if (diff.down.length > 0) {
    lines.push('*Google services down*');
    for (const name of diff.down) {
      const state = snapshot.services[name];
      const status = state ? `HTTP ${state.httpStatus}` : 'missing';
      lines.push(`• *${name}* (${status})`);
    }
  }
  if (diff.recovered.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('*Google services recovered*');
    for (const name of diff.recovered) {
      lines.push(`• *${name}* is back`);
    }
  }
  const stillOk = Object.entries(snapshot.services)
    .filter(([, state]) => state.ok)
    .map(([name]) => name);
  if (diff.down.length > 0 && stillOk.length > 0) {
    lines.push('');
    lines.push(`Still ok: ${stillOk.join(', ')}`);
  }
  if (diff.down.length > 0 && snapshot.hint) {
    lines.push('');
    lines.push(snapshot.hint);
  }
  return lines.join('\n');
}

export function loadAuthSnapshot(statePath: string): AuthSnapshot | null {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as AuthSnapshot;
    if (!parsed?.services || typeof parsed.services !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveAuthSnapshot(
  statePath: string,
  snapshot: AuthSnapshot,
): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function runDefaultAuthProbe(): Promise<AuthSnapshot> {
  const onecliBin = process.env.ONECLI_BIN || 'onecli';
  const { stdout } = await execFileAsync(
    onecliBin,
    ['run', '--', 'bash', CHECK_SCRIPT, '--json'],
    {
      timeout: 45_000,
      env: {
        ...process.env,
        ...(ONECLI_URL ? { ONECLI_API_HOST: ONECLI_URL } : {}),
      },
    },
  );
  const snapshot = parseAuthProbeJson(stdout);
  snapshot.checkedAt = new Date().toISOString();
  return snapshot;
}

export async function pollGoogleAuthOnce(
  deps: GoogleAuthMonitorDeps,
): Promise<AuthDiff | null> {
  const statePath = deps.statePath ?? GOOGLE_AUTH_STATE_PATH;
  const now = deps.now ?? (() => new Date());
  const runProbe = deps.runProbe ?? runDefaultAuthProbe;
  let snapshot: AuthSnapshot;
  try {
    snapshot = await runProbe();
    snapshot.checkedAt = now().toISOString();
  } catch (err) {
    logger.error({ err }, 'Google auth probe failed');
    return null;
  }

  const previous = loadAuthSnapshot(statePath);
  const diff = diffAuthSnapshots(previous, snapshot);
  saveAuthSnapshot(statePath, snapshot);

  if (diff.down.length === 0 && diff.recovered.length === 0) {
    logger.debug({ services: snapshot.services }, 'Google auth poll unchanged');
    return diff;
  }

  const jid = deps.getAlertJid();
  const text = formatAuthAlert(diff, snapshot);
  if (!jid) {
    logger.warn(
      { down: diff.down, recovered: diff.recovered },
      'Google auth changed but no main chat JID to notify',
    );
    return diff;
  }
  try {
    await deps.sendMessage(jid, text);
    logger.info(
      { jid, down: diff.down, recovered: diff.recovered },
      'Google auth WhatsApp alert sent',
    );
  } catch (err) {
    logger.error({ err, jid }, 'Failed to send Google auth WhatsApp alert');
  }
  return diff;
}

export function startGoogleAuthMonitor(
  deps: GoogleAuthMonitorDeps,
): () => void {
  stopGoogleAuthMonitor();
  const intervalMs = deps.intervalMs ?? GOOGLE_AUTH_POLL_MS;
  const initialDelayMs = deps.initialDelayMs ?? GOOGLE_AUTH_INITIAL_DELAY_MS;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await pollGoogleAuthOnce(deps);
    } finally {
      inFlight = false;
    }
  };

  const initial = setTimeout(() => {
    void tick();
  }, initialDelayMs);
  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  interval.unref?.();
  initial.unref?.();

  stopMonitor = () => {
    clearTimeout(initial);
    clearInterval(interval);
    stopMonitor = undefined;
  };
  logger.info({ intervalMs, initialDelayMs }, 'Google auth monitor started');
  return stopMonitor;
}

export function stopGoogleAuthMonitor(): void {
  stopMonitor?.();
}

export function _resetGoogleAuthMonitorForTests(): void {
  stopGoogleAuthMonitor();
}
