import 'dotenv/config';
import path from 'node:path';

function env(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  botName: env('BOT_NAME', 'GuildSmith'),
  token: env('DISCORD_TOKEN'),
  clientId: env('DISCORD_CLIENT_ID'),
  /** When set, slash commands register instantly to this one server (great for testing). */
  devGuildId: env('DEV_GUILD_ID'),
  dataDir: path.resolve(env('DATA_DIR', path.join(process.cwd(), 'data'))),
  /** Secret used to encrypt stored API keys. Auto-generated into data/secret.key when empty. */
  encryptionKey: env('ENCRYPTION_KEY'),

  ollama: {
    url: env('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    model: env('OLLAMA_MODEL', 'qwen3:4b'),
    numCtx: envInt('OLLAMA_NUM_CTX', 8192),
    /** How many AI requests Ollama handles at once. Everyone else waits in a queue. */
    concurrency: Math.max(1, envInt('OLLAMA_CONCURRENCY', 1)),
    autoPull: env('OLLAMA_AUTO_PULL', 'true') !== 'false',
  },

  /** Provider used by servers that never ran /provider. */
  defaultProvider: env('DEFAULT_PROVIDER', 'ollama'),
  maxActionsPerPlan: envInt('MAX_ACTIONS_PER_PLAN', 150),
  logLevel: env('LOG_LEVEL', 'info'),
};

/** Optional bot-owner API keys from .env, used when a server hasn't set its own key. */
export function envApiKey(provider: string): string {
  const map: Record<string, string> = {
    gemini: 'GEMINI_API_KEY',
    grok: 'XAI_API_KEY',
    groq: 'GROQ_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    fal: 'FAL_KEY',
    qwen: 'DASHSCOPE_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    zai: 'ZAI_API_KEY',
  };
  return map[provider] ? env(map[provider]) : '';
}

/** Optional base URL overrides, e.g. QWEN_BASE_URL for the China region or ZAI_BASE_URL for the coding plan. */
export function envBaseUrl(provider: string): string {
  return env(`${provider.toUpperCase()}_BASE_URL`);
}
