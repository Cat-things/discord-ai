import { config } from '../config';
import { log } from '../logger';
import { ProviderInfo } from './providers';
import { ollamaQueue } from './queue';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ResolvedProvider {
  info: ProviderInfo;
  apiKey: string;
  model: string;
}

export interface ChatOptions {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Progress callback for slow paths (queue position, model download...). */
  onStatus?: (text: string) => void;
}

export class AIError extends Error {
  constructor(
    message: string,
    public readonly code: 'model_not_found' | 'auth' | 'rate_limit' | 'unreachable' | 'bad_response' | 'other' = 'other',
  ) {
    super(message);
  }
}

const CLOUD_TIMEOUT_MS = 3 * 60_000;
const OLLAMA_TIMEOUT_MS = 20 * 60_000;

interface HttpResult {
  ok: boolean;
  status: number;
  data: any;
  text: string;
}

async function http(url: string, init: RequestInit & { timeoutMs?: number }): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? CLOUD_TIMEOUT_MS) });
  } catch (err: any) {
    if (err?.name === 'TimeoutError') throw new AIError('The AI took too long to answer (timed out). Try again or use a faster model.', 'unreachable');
    throw new AIError(`Could not reach ${new URL(url).host}: ${err?.cause?.code ?? err?.message ?? err}`, 'unreachable');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { ok: res.ok, status: res.status, data, text };
}

function errorMessage(r: HttpResult): string {
  const e = r.data?.error;
  const msg = typeof e === 'string' ? e : e?.message ?? r.data?.message ?? r.data?.detail ?? r.text;
  return String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 400);
}

function classify(r: HttpResult, provider: string): AIError {
  const msg = errorMessage(r);
  const lower = msg.toLowerCase();
  if (r.status === 401 || r.status === 403) return new AIError(`${provider} rejected the API key (${r.status}): ${msg}`, 'auth');
  if (r.status === 429) return new AIError(`${provider} rate limit / quota hit: ${msg}`, 'rate_limit');
  if (
    r.status === 404 ||
    (lower.includes('model') &&
      /(not found|does not exist|not exist|invalid model|unknown model|decommissioned|deprecated|not supported|no endpoints)/.test(lower))
  ) {
    return new AIError(`${provider} doesn't know that model: ${msg}`, 'model_not_found');
  }
  return new AIError(`${provider} error ${r.status}: ${msg}`);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part: any) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

/** Reads "max_tokens must be <= 8192"-style limits out of provider errors. */
function tokenLimitFrom(message: string): number | undefined {
  const m = /(?:<=|less than or equal to|maximum(?: value| allowed)?(?: is| of)?|at most|up to|limit(?: is)?|range[^0-9]*\d+\s*(?:to|-|,))\s*`?\[?(\d{3,7})/i.exec(message);
  return m ? Number(m[1]) : undefined;
}

async function openAiCompatibleChat(p: ResolvedProvider, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const { info } = p;
  let tokenField = info.usesMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens';
  let sendTemperature = !info.usesMaxCompletionTokens;
  let sendJsonMode = !!opts.json;
  // Reasoning models spend output tokens on thinking; keep it short and leave room for the answer.
  let sendReasoningEffort = !!info.usesMaxCompletionTokens;
  let maxTokens = info.usesMaxCompletionTokens ? Math.max(opts.maxTokens ?? 8192, 16000) : opts.maxTokens ?? 8192;

  // Providers disagree on which knobs they accept, so adapt and retry instead of failing.
  for (let attempt = 0; attempt < 6; attempt++) {
    const body: Record<string, unknown> = { model: p.model, messages, [tokenField]: maxTokens };
    if (sendTemperature) body.temperature = opts.temperature ?? 0.4;
    if (sendJsonMode) body.response_format = { type: 'json_object' };
    if (sendReasoningEffort) body.reasoning_effort = 'low';

    const r = await http(`${info.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...info.authHeader?.(p.apiKey) },
      body: JSON.stringify(body),
    });

    if (r.ok) {
      const choice = r.data?.choices?.[0];
      const text = textFromContent(choice?.message?.content);
      if (!text.trim()) {
        if (choice?.finish_reason === 'length') throw new AIError('The AI ran out of output tokens before answering. Try a shorter request or a non-reasoning model.', 'bad_response');
        throw new AIError(`${info.name} returned an empty answer.`, 'bad_response');
      }
      return text;
    }

    const message = errorMessage(r);
    const lower = message.toLowerCase();
    if (r.status === 400 || r.status === 422) {
      if (sendReasoningEffort && lower.includes('reasoning')) {
        sendReasoningEffort = false;
        continue;
      }
      if (sendJsonMode && (lower.includes('response_format') || lower.includes('json'))) {
        sendJsonMode = false;
        continue;
      }
      if (/max_(completion_)?tokens|max tokens|output tokens/.test(lower)) {
        const limit = tokenLimitFrom(message);
        if (limit && limit < maxTokens) {
          maxTokens = limit;
          continue;
        }
        if (tokenField === 'max_tokens' && /unsupported|not supported|max_completion_tokens/.test(lower)) {
          tokenField = 'max_completion_tokens';
          continue;
        }
        if (tokenField === 'max_completion_tokens' && /unsupported|not supported|unrecognized|unknown|extra/.test(lower)) {
          tokenField = 'max_tokens';
          continue;
        }
        if (maxTokens > 4096) {
          maxTokens = 4096;
          continue;
        }
      }
      if (lower.includes('temperature') && sendTemperature) {
        sendTemperature = false;
        continue;
      }
    }
    throw classify(r, info.name);
  }
  throw new AIError(`${info.name} kept rejecting the request.`);
}

async function anthropicChat(p: ResolvedProvider, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  let sendTemperature = true;

  for (let attempt = 0; attempt < 2; attempt++) {
    const body: Record<string, unknown> = { model: p.model, max_tokens: opts.maxTokens ?? 8192, system, messages: convo };
    if (sendTemperature) body.temperature = opts.temperature ?? 0.4;
    const r = await http(`${p.info.baseUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...p.info.authHeader?.(p.apiKey) },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const text = (r.data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      if (!text.trim()) throw new AIError('Claude returned an empty answer.', 'bad_response');
      return text;
    }
    if (r.status === 400 && sendTemperature && errorMessage(r).toLowerCase().includes('temperature')) {
      sendTemperature = false;
      continue;
    }
    throw classify(r, p.info.name);
  }
  throw new AIError('Anthropic kept rejecting the request.');
}

async function ollamaPull(model: string, opts: ChatOptions): Promise<void> {
  opts.onStatus?.(`📥 Downloading the local model \`${model}\` for the first time. This can take a while on slow internet...`);
  log.info(`Pulling Ollama model ${model}`);
  const r = await http(`${config.ollama.url}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false }),
    timeoutMs: 2 * 60 * 60_000,
  });
  if (!r.ok) throw new AIError(`Ollama couldn't download \`${model}\`: ${errorMessage(r)}`, 'model_not_found');
}

async function ollamaChat(p: ResolvedProvider, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const release = await ollamaQueue.acquire((position) =>
    opts.onStatus?.(`⏳ The local AI is busy. You're **#${position}** in the queue (Ollama is free but slow on high usage).`),
  );
  try {
    let sendThink = true;
    let pulled = false;
    // Ollama silently drops the start of prompts that don't fit num_ctx (that's the system prompt!), so size it to fit.
    const promptTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3);
    const numPredict = opts.maxTokens ?? 8192;
    const numCtx = Math.min(32768, Math.max(config.ollama.numCtx, promptTokens + Math.min(numPredict, 6000)));
    for (let attempt = 0; attempt < 3; attempt++) {
      const body: Record<string, unknown> = {
        model: p.model,
        messages,
        stream: false,
        keep_alive: '30m',
        options: { num_ctx: numCtx, temperature: opts.temperature ?? 0.4, num_predict: numPredict },
      };
      if (opts.json) body.format = 'json';
      if (sendThink) body.think = false;

      let r: HttpResult;
      try {
        r = await http(`${config.ollama.url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          timeoutMs: OLLAMA_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof AIError && err.code === 'unreachable' && !err.message.includes('timed out')) {
          throw new AIError(
            `Ollama isn't running at ${config.ollama.url}. Install it from https://ollama.com/download and make sure it's started (\`ollama serve\`).`,
            'unreachable',
          );
        }
        throw err;
      }

      if (r.ok) {
        const text = String(r.data?.message?.content ?? '');
        if (!text.trim()) throw new AIError('The local model returned an empty answer. Try a bigger model (OLLAMA_MODEL).', 'bad_response');
        return text;
      }
      const lower = errorMessage(r).toLowerCase();
      if (sendThink && lower.includes('think')) {
        sendThink = false;
        continue;
      }
      if (!pulled && config.ollama.autoPull && (r.status === 404 || lower.includes('not found'))) {
        await ollamaPull(p.model, opts);
        pulled = true;
        opts.onStatus?.('✅ Model downloaded. Thinking...');
        continue;
      }
      throw classify(r, 'Ollama');
    }
    throw new AIError('Ollama kept rejecting the request.');
  } finally {
    release();
  }
}

export async function chat(p: ResolvedProvider, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const started = Date.now();
  const run = p.info.kind === 'anthropic' ? anthropicChat : p.info.kind === 'ollama' ? ollamaChat : openAiCompatibleChat;
  const text = await run(p, messages, opts);
  log.debug(`[ai] ${p.info.id}/${p.model} answered in ${Date.now() - started}ms (${text.length} chars)`);
  return text;
}

/** Lists the model ids the provider offers. Returns [] when the provider has no listing endpoint. */
export async function listModels(info: ProviderInfo, apiKey: string): Promise<string[]> {
  try {
    if (info.kind === 'ollama') {
      const r = await http(`${config.ollama.url}/api/tags`, { method: 'GET', timeoutMs: 5000 });
      return r.ok ? (r.data?.models ?? []).map((m: any) => String(m.name)) : [];
    }
    const r = await http(`${info.baseUrl}/models`, { method: 'GET', headers: { ...info.authHeader?.(apiKey) }, timeoutMs: 15_000 });
    if (!r.ok) return [];
    const items: any[] = r.data?.data ?? r.data?.models ?? [];
    return items.map((m) => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
  } catch {
    return [];
  }
}

const NON_CHAT = /(embed|tts|whisper|dall-e|image|audio|realtime|moderation|transcribe|search|guard|rerank|ocr|vision-preview|sora|video|speech)/i;

/** Picks the best available model: the first preferred one the provider actually lists. */
export async function pickModel(info: ProviderInfo, apiKey: string): Promise<{ model: string; available: string[] }> {
  const available = await listModels(info, apiKey);
  if (!available.length) return { model: info.defaultModel, available };
  const found = info.preferredModels.find((m) => available.includes(m));
  if (found) return { model: found, available };
  if (available.includes(info.defaultModel)) return { model: info.defaultModel, available };
  const fallback = available.find((m) => !NON_CHAT.test(m));
  return { model: fallback ?? info.defaultModel, available };
}
