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
});
