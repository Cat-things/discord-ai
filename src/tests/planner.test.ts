import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fakeChannel, fakeGuild } from './fakes';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-plan-'));

const replies: string[] = [];
const requests: any[] = [];
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }));
      }
      requests.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: replies.shift() ?? '{}' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.DEFAULT_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = 'gsk_test';
});

after(() => server.close());

test('makePlan sends the server snapshot, retries broken JSON and returns a validated plan', async () => {
  const { makePlan } = await import('../ai/planner');
  const { guild } = fakeGuild({ botAdmin: true });
  Object.assign(guild, { premiumTier: 0, description: null, preferredLocale: 'en-US', systemChannelId: null, rulesChannelId: null, publicUpdatesChannelId: null, afkChannelId: null, explicitContentFilter: 0 });
  const general = fakeChannel(guild, { name: 'general' });
  guild.channels.cache.set(general.id, general);

  replies.push('Sure!! here is the plan: {"reply": "ok", "actions": [{"type": "create_rol", "nam": "x"}]}');
  replies.push(
    '```json\n{"reply":"Built it 🎉","summary":"roles + channel","actions":[{"type":"create_role","name":"Member"},{"type":"create_channel","name":"memes","category":"FUN"}]}\n```',
  );

  const statuses: string[] = [];
  const plan = await makePlan(guild, { mode: 'ask', prompt: 'add a memes channel and a member role' }, (s) => statuses.push(s));

  assert.equal(plan.reply, 'Built it 🎉');
  assert.deepEqual(plan.actions.map((a) => a.type), ['create_role', 'create_channel']);
  assert.equal(plan.invalid.length, 0);
  assert.equal(plan.providerName, 'Groq');
  assert.equal(requests.length, 2, 'retried once after invalid steps');
  assert.ok(statuses.some((s) => s.includes('fix')));

  const first = requests[0];
  assert.equal(first.response_format.type, 'json_object');
  assert.equal(first.messages[0].role, 'system');
  assert.match(first.messages[0].content, /create_channel/);
  const snapshotLine = first.messages[1].content.split('\n')[1];
  const snapshot = JSON.parse(snapshotLine);
  assert.equal(snapshot.server.name, 'Test Server');
  assert.ok(snapshot.roles.some((r: any) => r.name === 'Old Mod'));
  assert.ok(snapshot.channels_without_category.some((c: any) => c.name === 'general'));
  assert.match(requests[1].messages[3].content, /invalid/);
});

test('makePlan surfaces a clear error when the AI never returns JSON', async () => {
  const { makePlan } = await import('../ai/planner');
  const { guild } = fakeGuild({ botAdmin: true });
  Object.assign(guild, { premiumTier: 0, preferredLocale: 'en-US', explicitContentFilter: 0 });
  replies.push('I cannot do that.', 'Still no JSON, sorry.');
  await assert.rejects(makePlan(guild, { mode: 'modify', prompt: 'rename general' }), /didn't return a usable plan/);
});
