import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

type Handler = (req: http.IncomingMessage, body: any) => { status: number; json: unknown };
let handler: Handler = () => ({ status: 500, json: {} });
const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
let server: http.Server;
let base = '';

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      const out = handler(req, body);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.OLLAMA_URL = base;
  process.env.OLLAMA_MODEL = 'tiny:1b';
});

after(() => server.close());

const load = async () => {
  const client = await import('../ai/client');
  const { PROVIDERS } = await import('../ai/providers');
  return { ...client, PROVIDERS };
};

test('OpenAI-compatible: adapts to max_completion_tokens / no temperature / no json mode', async () => {
  const { chat, PROVIDERS } = await load();
  const info = { ...PROVIDERS.get('groq')!, baseUrl: base };
  seen.length = 0;
  handler = (_req, body) => {
    if ('max_tokens' in body) return { status: 400, json: { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." } } };
    if ('temperature' in body) return { status: 400, json: { error: { message: 'temperature does not support 0.4 with this model' } } };
    if (body.response_format) return { status: 400, json: { error: { message: 'response_format json_object is not supported' } } };
    return { status: 200, json: { choices: [{ message: { content: '{"ok":true}' } }] } };
  };
  const out = await chat({ info, apiKey: 'k-123', model: 'm' }, [{ role: 'user', content: 'hi' }], { json: true });
  assert.equal(out, '{"ok":true}');
  assert.equal(seen.length, 4);
  assert.equal(seen[0].headers.authorization, 'Bearer k-123');
  assert.ok(seen[3].body.max_completion_tokens);
});

test('OpenAI-compatible: auth and missing-model errors are classified', async () => {
  const { chat, AIError, PROVIDERS } = await load();
  const info = { ...PROVIDERS.get('openai')!, baseUrl: base };
  handler = () => ({ status: 401, json: { error: { message: 'Incorrect API key provided' } } });
  await assert.rejects(chat({ info, apiKey: 'bad', model: 'm' }, [{ role: 'user', content: 'hi' }]), (e: any) => e instanceof AIError && e.code === 'auth');
  handler = () => ({ status: 404, json: { error: { message: 'The model `gpt-old` does not exist' } } });
  await assert.rejects(chat({ info, apiKey: 'k', model: 'gpt-old' }, [{ role: 'user', content: 'hi' }]), (e: any) => e.code === 'model_not_found');
});

test('fal uses the "Key" auth header', async () => {
  const { chat, PROVIDERS } = await load();
  const info = { ...PROVIDERS.get('fal')!, baseUrl: base };
  seen.length = 0;
  handler = () => ({ status: 200, json: { choices: [{ message: { content: [{ type: 'text', text: 'hey' }] } }] } });
  assert.equal(await chat({ info, apiKey: 'fal-xyz', model: 'm' }, [{ role: 'user', content: 'hi' }]), 'hey');
  assert.equal(seen[0].headers.authorization, 'Key fal-xyz');
});

test('Anthropic: system prompt goes top-level, text blocks are joined', async () => {
  const { chat, PROVIDERS } = await load();
  const info = { ...PROVIDERS.get('anthropic')!, baseUrl: base };
  seen.length = 0;
  handler = () => ({ status: 200, json: { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }] } });
  const out = await chat({ info, apiKey: 'sk-ant', model: 'claude-sonnet-5-5' }, [
    { role: 'system', content: 'be nice' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(out, 'Hello there');
  assert.equal(seen[0].url, '/messages');
  assert.equal(seen[0].body.system, 'be nice');
  assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(seen[0].headers['x-api-key'], 'sk-ant');
  assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
});

test('Ollama: downloads a missing model automatically, then answers', async () => {
  const { chat, PROVIDERS } = await load();
  const info = PROVIDERS.get('ollama')!;
  assert.equal(info.baseUrl, base);
  seen.length = 0;
  let pulled = false;
  handler = (req, body) => {
    if (req.url === '/api/pull') {
      pulled = true;
      return { status: 200, json: { status: 'success' } };
    }
    if (!pulled) return { status: 404, json: { error: `model "${body.model}" not found, try pulling it first` } };
    return { status: 200, json: { message: { role: 'assistant', content: '{"reply":"hi"}' } } };
  };
  const statuses: string[] = [];
  const out = await chat({ info, apiKey: '', model: 'tiny:1b' }, [{ role: 'user', content: 'hi' }], { json: true, onStatus: (s) => statuses.push(s) });
  assert.equal(out, '{"reply":"hi"}');
  assert.deepEqual(seen.map((s) => s.url), ['/api/chat', '/api/pull', '/api/chat']);
  assert.equal(seen[0].body.format, 'json');
  assert.equal(seen[0].body.stream, false);
  assert.ok(statuses.some((s) => s.includes('Downloading')));
});

test('pickModel prefers the first preferred model the provider lists', async () => {
  const { pickModel, PROVIDERS } = await load();
  const info = { ...PROVIDERS.get('zai')!, baseUrl: base };
  handler = () => ({ status: 200, json: { data: [{ id: 'glm-4.5' }, { id: 'glm-5.1' }, { id: 'embedding-3' }] } });
  assert.equal((await pickModel(info, 'k')).model, 'glm-5.1');
  handler = () => ({ status: 200, json: { data: [{ id: 'text-embedding-x' }, { id: 'weird-chat-model' }] } });
  assert.equal((await pickModel(info, 'k')).model, 'weird-chat-model');
  handler = () => ({ status: 404, json: {} });
  assert.equal((await pickModel(info, 'k')).model, info.defaultModel);
});

test('OpenAI-compatible: lowers max tokens when the provider states a limit, drops reasoning_effort', async () => {
  const { chat, PROVIDERS } = await load();
  seen.length = 0;
  const deepseek = { ...PROVIDERS.get('deepseek')!, baseUrl: base };
  handler = (_req, body) =>
    body.max_tokens > 8192
      ? { status: 400, json: { error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]' } } }
      : { status: 200, json: { choices: [{ message: { content: 'ok' } }] } };
  assert.equal(await chat({ info: deepseek, apiKey: 'k', model: 'deepseek-chat' }, [{ role: 'user', content: 'hi' }], { maxTokens: 12000 }), 'ok');
  assert.equal(seen[1].body.max_tokens, 8192);

  seen.length = 0;
  const openai = { ...PROVIDERS.get('openai')!, baseUrl: base };
  handler = (_req, body) =>
    body.reasoning_effort
      ? { status: 400, json: { error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." } } }
      : { status: 200, json: { choices: [{ message: { content: 'ok' } }] } };
  assert.equal(await chat({ info: openai, apiKey: 'k', model: 'gpt-4.1' }, [{ role: 'user', content: 'hi' }]), 'ok');
  assert.equal(seen[0].body.reasoning_effort, 'low');
  assert.equal(seen[1].body.reasoning_effort, undefined);
  assert.ok(seen[1].body.max_completion_tokens >= 16000);
});
