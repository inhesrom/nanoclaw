import { describe, expect, it } from 'vitest';

import {
  type EvenHubRuntimeConfig,
  validateEvenHubRuntimeConfig,
} from './config.js';

const approved: EvenHubRuntimeConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 18791,
  publicOrigin: 'https://nanoclaw.local',
  whisperUrl: 'http://127.0.0.1:8178/inference',
  maxAudioBytes: 960_000,
  pairingTtlMs: 300_000,
  turnRetentionMs: 604_800_000,
};

describe('EvenHub runtime configuration', () => {
  it('accepts the reviewed private LAN configuration', () => {
    expect(() => validateEvenHubRuntimeConfig(approved)).not.toThrow();
  });

  it.each([
    ['host', '0.0.0.0'],
    ['port', 8080],
    ['publicOrigin', 'http://nanoclaw.local'],
    ['whisperUrl', 'http://192.168.1.20:8178/inference'],
    ['maxAudioBytes', 2_000_000],
    ['pairingTtlMs', 600_000],
    ['turnRetentionMs', 86_400_000],
  ] as const)('rejects drift in %s', (name, value) => {
    expect(() =>
      validateEvenHubRuntimeConfig({ ...approved, [name]: value }),
    ).toThrow(`Invalid EvenHub configuration: ${name}`);
  });

  it('does not constrain configuration while the slice is disabled', () => {
    expect(() =>
      validateEvenHubRuntimeConfig({
        ...approved,
        enabled: false,
        host: '0.0.0.0',
      }),
    ).not.toThrow();
  });
});
