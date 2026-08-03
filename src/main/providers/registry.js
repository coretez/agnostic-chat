'use strict';

/**
 * Supported model providers.
 *
 * `style` selects the wire protocol:
 *   - 'openai'    → OpenAI-compatible /chat/completions + /models (OpenAI, Qwen, Kimi)
 *   - 'anthropic' → Anthropic Messages API (/v1/messages + /v1/models)
 *
 * `baseUrl` is the default and is user-editable per connection (regional
 * endpoints, self-hosted gateways, etc.). `fallbackModels` are only used to seed
 * the picker before a live /models fetch succeeds — the real list comes from the
 * provider. Model ids move fast; treat these as hints, not truth.
 */
const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    style: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-…',
    docs: 'https://platform.openai.com/api-keys',
    help: [
      'Sign in at platform.openai.com (a paid account with billing set up is required).',
      'Open the API keys page and choose “Create new secret key”.',
      'Name it, then copy the key — it starts with sk-… and is shown only once.',
      'Paste it into the API Key field here; it is encrypted in your macOS Keychain and never shown again.'
    ],
    // Seeds shown before a live /models fetch. As of Aug 2026 OpenAI's line is
    // the GPT-5 family; your account's real ids come from TEST → /models.
    fallbackModels: ['gpt-5.6', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-4o']
  },
  anthropic: {
    label: 'Claude (Anthropic)',
    style: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyHint: 'sk-ant-…',
    docs: 'https://console.anthropic.com/settings/keys',
    help: [
      'Sign in at console.anthropic.com.',
      'Go to Settings → API keys → “Create Key”.',
      'Copy the key — it starts with sk-ant-… and is shown only once.',
      'Paste it here; it is encrypted in your Keychain and never leaves this Mac except to call Anthropic.'
    ],
    fallbackModels: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5']
  },
  qwen: {
    label: 'Qwen (DashScope)',
    style: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyHint: 'sk-…',
    docs: 'https://bailian.console.alibabacloud.com/',
    help: [
      'Sign in to Alibaba Cloud Model Studio (the “bailian” console).',
      'Open API-KEY and create a DashScope API key.',
      'Copy the key (starts with sk-…).',
      'Keep the international base URL unless your account is in mainland China — then switch to https://dashscope.aliyuncs.com/compatible-mode/v1.'
    ],
    fallbackModels: ['qwen3.6-plus', 'qwen3.6-flash', 'qwen3.7-max']
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    style: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyHint: 'sk-…',
    docs: 'https://platform.moonshot.ai/console/api-keys',
    help: [
      'Sign in at platform.moonshot.ai.',
      'Open Console → API Keys and create a key.',
      'Copy the key (starts with sk-…).',
      'Use api.moonshot.ai for the international endpoint, or api.moonshot.cn if your account is in China.'
    ],
    fallbackModels: ['kimi-k2.6', 'kimi-k3']
  },
  gemini: {
    label: 'Gemini (Google)',
    style: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyHint: 'AIza…',
    docs: 'https://aistudio.google.com/app/apikey',
    help: [
      'Open Google AI Studio at aistudio.google.com and sign in with your Google account.',
      'Click “Get API key” → “Create API key”.',
      'Copy the key (starts with AIza…).',
      'Paste it here; it is encrypted in your Keychain. This uses Gemini’s OpenAI-compatible endpoint.'
    ],
    fallbackModels: ['gemini-2.5-pro', 'gemini-2.5-flash']
  }
};

/** Public metadata for the "Add connection" form (no secrets). */
function registryList() {
  return Object.entries(PROVIDERS).map(([type, p]) => ({
    type, label: p.label, style: p.style, baseUrl: p.baseUrl,
    keyHint: p.keyHint, docs: p.docs, help: p.help, fallbackModels: p.fallbackModels
  }));
}

module.exports = { PROVIDERS, registryList };
