import { describe, expect, it } from 'vitest';

import {
  buildAgentSettingsSnapshot,
  modelOptions,
  resolveRuntimeAgentSettings,
  updateProviderAgentSettings,
} from './agent-settings.js';

describe('agent settings resolution', () => {
  it('uses chat overrides before provider defaults', () => {
    const defaults = {
      codex: {
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
      },
    };
    const chat = {
      codex: {
        reasoningEffort: 'xhigh',
      },
    };

    expect(resolveRuntimeAgentSettings('codex', chat, defaults)).toEqual({
      model: 'gpt-5-codex',
      reasoningEffort: 'xhigh',
    });
  });

  it('clears empty provider settings after auto updates', () => {
    const settings = updateProviderAgentSettings(
      { claude: { model: 'claude-opus-4-6' } },
      'claude',
      { model: null },
    );

    expect(settings).toEqual({});
  });

  it('builds snapshots with provider fallback source', () => {
    const snapshot = buildAgentSettingsSnapshot({}, {}, 'claude', true);

    expect(snapshot.providers.claude.model).toMatchObject({
      effective: null,
      source: 'provider',
      chatOverride: null,
      defaultValue: null,
    });
  });

  it('lists GPT-5.6 Sol, Terra, and Luna as Codex model options', () => {
    expect(modelOptions('codex')).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
    );
  });

  it('persists Codex tier nicknames as canonical GPT-5.6 slugs', () => {
    expect(updateProviderAgentSettings({}, 'codex', { model: 'sol' })).toEqual({
      codex: { model: 'gpt-5.6-sol' },
    });
    expect(
      updateProviderAgentSettings({}, 'codex', { model: 'Terra' }),
    ).toEqual({
      codex: { model: 'gpt-5.6-terra' },
    });
    expect(updateProviderAgentSettings({}, 'codex', { model: 'LUNA' })).toEqual(
      {
        codex: { model: 'gpt-5.6-luna' },
      },
    );
  });

  it('resolves a leftover sol chat override to gpt-5.6-sol', () => {
    expect(
      resolveRuntimeAgentSettings(
        'codex',
        { codex: { model: 'sol', reasoningEffort: 'xhigh' } },
        { codex: { model: 'gpt-5.6-luna' } },
      ),
    ).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
    });
  });

  it('lists grok-4.5 as a Grok model option and accepts grok provider', () => {
    expect(modelOptions('grok')).toContain('grok-4.5');
    const snapshot = buildAgentSettingsSnapshot(
      { grok: { model: 'grok-4.5', reasoningEffort: 'high' } },
      {},
      'grok',
      true,
    );
    expect(snapshot.currentRuntime).toBe('grok');
    expect(snapshot.providers.grok.model).toMatchObject({
      effective: 'grok-4.5',
      source: 'chat',
    });
  });
});
