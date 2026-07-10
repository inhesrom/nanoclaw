import {
  AgentProvider,
  AgentRuntime,
  AgentSettingValueSnapshot,
  AgentSettings,
  AgentSettingsSnapshot,
  ProviderAgentSettings,
  RuntimeAgentSettings,
} from './types.js';

export const AGENT_DEFAULTS_STATE_KEY = 'agent_defaults';

export const AGENT_PROVIDERS: AgentProvider[] = ['claude', 'codex'];

export const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'];
export const CODEX_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

export const CLAUDE_MODEL_OPTIONS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5',
  'sonnet',
  'opus',
  'haiku',
];

export const CODEX_MODEL_OPTIONS = [
  'gpt-5.6-terra',
  'gpt-5-codex',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5',
];

const MODEL_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeProvider(value: unknown): AgentProvider | undefined {
  const provider = nonEmptyString(value)?.toLowerCase();
  return provider === 'claude' || provider === 'codex' ? provider : undefined;
}

export function validateModelSlug(model: string): boolean {
  return MODEL_SLUG_PATTERN.test(model);
}

export function reasoningEffortOptions(provider: AgentProvider): string[] {
  return provider === 'claude'
    ? [...CLAUDE_REASONING_EFFORTS]
    : [...CODEX_REASONING_EFFORTS];
}

export function modelOptions(provider: AgentProvider): string[] {
  return provider === 'claude'
    ? [...CLAUDE_MODEL_OPTIONS]
    : [...CODEX_MODEL_OPTIONS];
}

export function validateReasoningEffort(
  provider: AgentProvider,
  effort: string,
): boolean {
  return reasoningEffortOptions(provider).includes(effort);
}

function normalizeProviderSettings(
  provider: AgentProvider,
  value: unknown,
): ProviderAgentSettings | undefined {
  if (!isObject(value)) return undefined;

  const settings: ProviderAgentSettings = {};
  const model = nonEmptyString(value.model);
  if (model && validateModelSlug(model)) settings.model = model;

  const reasoningEffort = nonEmptyString(
    value.reasoningEffort ?? value.reasoning_effort,
  )?.toLowerCase();
  if (reasoningEffort && validateReasoningEffort(provider, reasoningEffort)) {
    settings.reasoningEffort = reasoningEffort;
  }

  return Object.keys(settings).length > 0 ? settings : undefined;
}

export function normalizeAgentSettings(value: unknown): AgentSettings {
  if (!isObject(value)) return {};

  const settings: AgentSettings = {};
  for (const provider of AGENT_PROVIDERS) {
    const providerSettings = normalizeProviderSettings(
      provider,
      value[provider],
    );
    if (providerSettings) settings[provider] = providerSettings;
  }
  return settings;
}

export function pruneAgentSettings(settings: AgentSettings): AgentSettings {
  return normalizeAgentSettings(settings);
}

export function updateProviderAgentSettings(
  current: AgentSettings | undefined,
  provider: AgentProvider,
  patch: {
    model?: string | null;
    reasoningEffort?: string | null;
  },
): AgentSettings {
  const next = normalizeAgentSettings(current ?? {});
  const providerSettings: ProviderAgentSettings = {
    ...(next[provider] ?? {}),
  };

  if ('model' in patch) {
    if (patch.model) {
      providerSettings.model = patch.model;
    } else {
      delete providerSettings.model;
    }
  }

  if ('reasoningEffort' in patch) {
    if (patch.reasoningEffort) {
      providerSettings.reasoningEffort = patch.reasoningEffort;
    } else {
      delete providerSettings.reasoningEffort;
    }
  }

  if (Object.keys(providerSettings).length > 0) {
    next[provider] = providerSettings;
  } else {
    delete next[provider];
  }

  return pruneAgentSettings(next);
}

export function resolveRuntimeAgentSettings(
  provider: AgentProvider,
  chatSettings: AgentSettings | undefined,
  defaultSettings: AgentSettings | undefined,
): RuntimeAgentSettings {
  const chat = normalizeAgentSettings(chatSettings ?? {})[provider];
  const defaults = normalizeAgentSettings(defaultSettings ?? {})[provider];

  return {
    model: chat?.model ?? defaults?.model,
    reasoningEffort: chat?.reasoningEffort ?? defaults?.reasoningEffort,
  };
}

function settingSnapshot(
  chatOverride: string | undefined,
  defaultValue: string | undefined,
): AgentSettingValueSnapshot {
  if (chatOverride) {
    return {
      effective: chatOverride,
      source: 'chat',
      chatOverride,
      defaultValue: defaultValue ?? null,
    };
  }
  if (defaultValue) {
    return {
      effective: defaultValue,
      source: 'default',
      chatOverride: null,
      defaultValue,
    };
  }
  return {
    effective: null,
    source: 'provider',
    chatOverride: null,
    defaultValue: null,
  };
}

export function buildAgentSettingsSnapshot(
  groupSettings: AgentSettings | undefined,
  defaultSettings: AgentSettings | undefined,
  currentRuntime: AgentRuntime,
  canSetDefaults: boolean,
): AgentSettingsSnapshot {
  const chat = normalizeAgentSettings(groupSettings ?? {});
  const defaults = normalizeAgentSettings(defaultSettings ?? {});
  const providers = {} as AgentSettingsSnapshot['providers'];

  for (const provider of AGENT_PROVIDERS) {
    providers[provider] = {
      model: settingSnapshot(chat[provider]?.model, defaults[provider]?.model),
      reasoningEffort: settingSnapshot(
        chat[provider]?.reasoningEffort,
        defaults[provider]?.reasoningEffort,
      ),
      modelOptions: modelOptions(provider),
      reasoningEffortOptions: reasoningEffortOptions(provider),
      customModelAllowed: true,
    };
  }

  return {
    currentRuntime,
    canSetDefaults,
    providers,
  };
}
