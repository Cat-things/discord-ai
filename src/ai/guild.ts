import { config, envApiKey } from '../config';
import { log } from '../logger';
import { decrypt } from '../storage/crypto';
import { getGuild, updateGuild } from '../storage/db';
import { AIError, chat, ChatMessage, ChatOptions, pickModel, ResolvedProvider } from './client';
import { getProvider, PROVIDERS } from './providers';

/** The provider, key and model a server uses (its own /provider setup, else the .env defaults). */
export function resolveGuildProvider(guildId: string): ResolvedProvider {
  const saved = getGuild(guildId).provider;
  const info = getProvider(saved?.id ?? config.defaultProvider) ?? PROVIDERS.get('ollama')!;
  let apiKey = '';
  if (saved?.apiKey && saved.id === info.id) apiKey = decrypt(saved.apiKey);
  if (!apiKey) apiKey = envApiKey(info.id);
  if (info.needsKey && !apiKey) {
    throw new AIError(`${info.name} needs an API key. An admin can run \`/provider set\` to add one (or pick the free local Ollama).`, 'auth');
  }
  const model = (saved?.id === info.id && saved.model) || info.defaultModel;
  return { info, apiKey, model };
}

/** Chat with the server's provider. If the model was retired, auto-picks a working one and retries once. */
export async function guildChat(guildId: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<{ text: string; provider: ResolvedProvider }> {
  const provider = resolveGuildProvider(guildId);
  try {
    return { text: await chat(provider, messages, opts), provider };
  } catch (err) {
    if (!(err instanceof AIError) || err.code !== 'model_not_found' || provider.info.kind === 'ollama') throw err;
    const { model } = await pickModel(provider.info, provider.apiKey);
    if (model === provider.model) throw err;
    log.warn(`[ai] ${provider.info.id}: model ${provider.model} unavailable, switching to ${model}`);
    opts.onStatus?.(`🔁 \`${provider.model}\` isn't available anymore, switching to \`${model}\`...`);
    updateGuild(guildId, (g) => {
      if (g.provider?.id === provider.info.id) g.provider.model = model;
    });
    const retry = { ...provider, model };
    return { text: await chat(retry, messages, opts), provider: retry };
  }
}

/** fal key for image generation: the server's own fal key, else FAL_KEY from .env. */
export function falKeyFor(guildId: string): string {
  const saved = getGuild(guildId).provider;
  if (saved?.id === 'fal' && saved.apiKey) return decrypt(saved.apiKey);
  return envApiKey('fal');
}
