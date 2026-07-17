import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';
import type { AgentRuntime } from './types.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
  'NANOCLAW_RUNTIME',
  'EVENHUB_ENABLED',
  'EVENHUB_HOST',
  'EVENHUB_PORT',
  'EVENHUB_PUBLIC_ORIGIN',
  'EVENHUB_MAX_AUDIO_BYTES',
  'EVENHUB_PAIRING_TTL_MS',
  'EVENHUB_TURN_RETENTION_MS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const EVENHUB_ENABLED =
  (process.env.EVENHUB_ENABLED || envConfig.EVENHUB_ENABLED) === 'true';
export const EVENHUB_HOST =
  process.env.EVENHUB_HOST || envConfig.EVENHUB_HOST || '127.0.0.1';
export const EVENHUB_PORT = parseInt(
  process.env.EVENHUB_PORT || envConfig.EVENHUB_PORT || '18791',
  10,
);
export const EVENHUB_PUBLIC_ORIGIN =
  process.env.EVENHUB_PUBLIC_ORIGIN ||
  envConfig.EVENHUB_PUBLIC_ORIGIN ||
  'https://nanoclaw.local';
// Fixed production boundary. Model/runtime selection lives in the tracked STT
// profile consumed by the loopback service, not in NanoClaw's environment.
export const EVENHUB_STT_URL = 'http://127.0.0.1:8178/v1/transcribe';
export const EVENHUB_MAX_AUDIO_BYTES = parseInt(
  process.env.EVENHUB_MAX_AUDIO_BYTES ||
    envConfig.EVENHUB_MAX_AUDIO_BYTES ||
    '960000',
  10,
);
export const EVENHUB_PAIRING_TTL_MS = parseInt(
  process.env.EVENHUB_PAIRING_TTL_MS ||
    envConfig.EVENHUB_PAIRING_TTL_MS ||
    '300000',
  10,
);
export const EVENHUB_TURN_RETENTION_MS = parseInt(
  process.env.EVENHUB_TURN_RETENTION_MS ||
    envConfig.EVENHUB_TURN_RETENTION_MS ||
    '604800000',
  10,
);

export interface EvenHubRuntimeConfig {
  enabled: boolean;
  host: string;
  port: number;
  publicOrigin: string;
  sttUrl: string;
  maxAudioBytes: number;
  pairingTtlMs: number;
  turnRetentionMs: number;
}

export const EVENHUB_RUNTIME_CONFIG: EvenHubRuntimeConfig = {
  enabled: EVENHUB_ENABLED,
  host: EVENHUB_HOST,
  port: EVENHUB_PORT,
  publicOrigin: EVENHUB_PUBLIC_ORIGIN,
  sttUrl: EVENHUB_STT_URL,
  maxAudioBytes: EVENHUB_MAX_AUDIO_BYTES,
  pairingTtlMs: EVENHUB_PAIRING_TTL_MS,
  turnRetentionMs: EVENHUB_TURN_RETENTION_MS,
};

const APPROVED_EVENHUB_CONFIG: Omit<EvenHubRuntimeConfig, 'enabled'> = {
  host: '127.0.0.1',
  port: 18791,
  publicOrigin: 'https://nanoclaw.local',
  sttUrl: 'http://127.0.0.1:8178/v1/transcribe',
  maxAudioBytes: 960_000,
  pairingTtlMs: 300_000,
  turnRetentionMs: 604_800_000,
};

/** Fail closed when the private LAN slice drifts from its reviewed boundary. */
export function validateEvenHubRuntimeConfig(
  config: EvenHubRuntimeConfig = EVENHUB_RUNTIME_CONFIG,
): void {
  if (!config.enabled) return;

  for (const [name, approved] of Object.entries(APPROVED_EVENHUB_CONFIG)) {
    const actual = config[name as keyof typeof APPROVED_EVENHUB_CONFIG];
    if (actual !== approved) {
      throw new Error(
        `Invalid EvenHub configuration: ${name} must be ${String(approved)}`,
      );
    }
  }
}

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;

// Default agent runtime for containers: 'claude' (Claude Agent SDK) or 'codex'
// (OpenAI Codex CLI). Per-group overrides live in registered_groups.runtime and are
// set at runtime via the set_runtime tool ("use codex/claude from now on").
export const DEFAULT_RUNTIME: AgentRuntime =
  (
    process.env.NANOCLAW_RUNTIME ||
    envConfig.NANOCLAW_RUNTIME ||
    ''
  ).toLowerCase() === 'claude'
    ? 'claude'
    : 'codex';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
