import { config, envBaseUrl } from '../config';

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'ollama';

export interface ProviderInfo {
  id: string;
  name: string;
  emoji: string;
  kind: ProviderKind;
  baseUrl: string;
  needsKey: boolean;
  /** Used when model auto-detection is not possible. */
  defaultModel: string;
  /** Preferred models, best first. When the provider lists its models, the first one available wins. */
  preferredModels: string[];
  keyUrl: string;
  /** Header name/prefix used for the API key. */
  authHeader?: (key: string) => Record<string, string>;
  /** OpenAI reasoning models want max_completion_tokens and no temperature. */
  usesMaxCompletionTokens?: boolean;
  note?: string;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

const catalog: ProviderInfo[] = [
  {
    id: 'ollama',
    name: 'Ollama (local, free)',
    emoji: '🦙',
    kind: 'ollama',
    baseUrl: config.ollama.url,
    needsKey: false,
    defaultModel: config.ollama.model,
    preferredModels: [config.ollama.model],
    keyUrl: 'https://ollama.com/download',
    note: 'Free and private, runs on the bot host. Slow on weak hardware or when many people use it at once (requests queue up).',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    emoji: '✨',
    kind: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    defaultModel: 'gemini-flash-latest',
    preferredModels: ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-3.5-flash', 'gemini-2.5-flash'],
    keyUrl: 'https://aistudio.google.com/apikey',
    authHeader: bearer,
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    emoji: '🅧',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    needsKey: true,
    defaultModel: 'grok-4.6',
    preferredModels: ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4-fast', 'grok-4', 'grok-3-mini'],
    keyUrl: 'https://console.x.ai',
    authHeader: bearer,
  },
  {
    id: 'groq',
    name: 'Groq',
    emoji: '⚡',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
    preferredModels: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile'],
    keyUrl: 'https://console.groq.com/keys',
    authHeader: bearer,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    emoji: '🤖',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    defaultModel: 'gpt-5-mini',
    preferredModels: ['gpt-5.5-mini', 'gpt-5-mini', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5'],
    keyUrl: 'https://platform.openai.com/api-keys',
    authHeader: bearer,
    usesMaxCompletionTokens: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    emoji: '🧠',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    needsKey: true,
    defaultModel: 'claude-sonnet-5-5',
    preferredModels: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    authHeader: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    emoji: '🔀',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    defaultModel: 'openrouter/auto',
    preferredModels: ['openrouter/auto'],
    keyUrl: 'https://openrouter.ai/keys',
    authHeader: (key) => ({ ...bearer(key), 'HTTP-Referer': 'https://github.com/cat-things/discord-ai', 'X-Title': config.botName }),
  },
  {
    id: 'fal',
    name: 'fal.ai',
    emoji: '🎨',
    kind: 'openai-compatible',
    baseUrl: 'https://fal.run/openrouter/router/openai/v1',
    needsKey: true,
    defaultModel: 'openai/gpt-5-mini',
    preferredModels: ['openai/gpt-5-mini'],
    keyUrl: 'https://fal.ai/dashboard/keys',
    authHeader: (key) => ({ Authorization: `Key ${key}` }),
    note: 'Chat goes through fal\'s OpenRouter router (OpenRouter model ids). Your fal key also unlocks AI-generated server icons.',
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba DashScope)',
    emoji: '🐉',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    needsKey: true,
    defaultModel: 'qwen-plus',
    preferredModels: ['qwen-plus', 'qwen-max', 'qwen-flash', 'qwen-turbo'],
    keyUrl: 'https://modelstudio.console.alibabacloud.com/',
    authHeader: bearer,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    emoji: '🐋',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    defaultModel: 'deepseek-chat',
    preferredModels: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    authHeader: bearer,
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    emoji: '🌬️',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    defaultModel: 'mistral-large-latest',
    preferredModels: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    authHeader: bearer,
  },
  {
    id: 'zai',
    name: 'Z.AI (GLM)',
    emoji: '🇿',
    kind: 'openai-compatible',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    needsKey: true,
    defaultModel: 'glm-5.1',
    preferredModels: ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.6', 'glm-4.5'],
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    authHeader: bearer,
  },
];

export const PROVIDERS: ReadonlyMap<string, ProviderInfo> = new Map(
  catalog.map((p) => [p.id, { ...p, baseUrl: (envBaseUrl(p.id) || p.baseUrl).replace(/\/+$/, '') }]),
);

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.get(id);
}

export function providerChoices(): { name: string; value: string }[] {
  return [...PROVIDERS.values()].map((p) => ({ name: p.name, value: p.id }));
}
