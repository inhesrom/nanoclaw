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

  it('lists GPT-5.6 Terra as a Codex model option', () => {
    expect(modelOptions('codex')).toContain('gpt-5.6-terra');
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
