import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-msg-'));
process.env.FAL_KEY = '';

import { fakeChannel, fakeGuild, fakeMessage } from './fakes';

const load = async () => {
  const exec = await import('../discord/executor');
  const actions = await import('../discord/actions');
  const messages = await import('../discord/messages');
  const db = await import('../storage/db');
  const snapshot = await import('../discord/snapshot');
  return { ...exec, ...actions, ...messages, db, buildSnapshot: snapshot.buildSnapshot };
};

let world: ReturnType<typeof fakeGuild>;
const addChannel = (name: string) => {
  const ch = fakeChannel(world.guild, { name });
  world.guild.channels.cache.set(ch.id, ch);
  return ch;
};
const run = async (raw: unknown[], allowDestructive = true) => {
  const { executePlan, normalizeActions, orderActions } = await load();
  const { actions, invalid } = normalizeActions(raw);
  assert.deepEqual(invalid, []);
  return executePlan({ guild: world.guild, actor: world.actor as any, actions: orderActions(actions), allowDestructive });
};
const customIds = (msg: any) => JSON.stringify(msg.components.map((c: any) => c.toJSON()));

beforeEach(() => {
  world = fakeGuild({ botAdmin: true });
});

test('message refs: links, id pairs and panel names', async () => {
  const { parseMessageRef, kindFromRef } = await load();
  assert.deepEqual(parseMessageRef('see https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333 pls'), {
    channelId: '222222222222222222',
    messageId: '333333333333333333',
  });
  assert.deepEqual(parseMessageRef('222222222222222222-333333333333333333'), { channelId: '222222222222222222', messageId: '333333333333333333' });
  assert.equal(parseMessageRef('hello'), undefined);
  assert.equal(kindFromRef('the verification panel'), 'verification');
  assert.equal(kindFromRef('Support tickets'), 'tickets');
  assert.equal(kindFromRef('self-roles menu'), 'role_menu');
  assert.equal(kindFromRef('welcome message'), undefined);
});

test('panels are tracked and can be moved; the source channel is only deleted after the move', async () => {
  const { db, buildSnapshot, describeAction } = await load();
  const old = addChannel('old-verify');
  await run([
    { type: 'create_role', name: 'Verified' },
    { type: 'create_verification', channel: 'old-verify', role: 'Verified' },
    { type: 'create_ticket_panel', channel: 'old-verify' },
  ]);
  const posts = db.getGuild(world.guild.id).posts!;
  assert.deepEqual(posts.map((p) => p.kind).sort(), ['tickets', 'verification']);
  const snap = buildSnapshot(world.guild) as any;
  assert.equal(snap.bot_messages.length, 2);
  assert.equal(snap.bot_messages[0].channel, '#old-verify');

  // The AI lists the delete first; it must still run after the moves.
  const result = await run([
    { type: 'delete_channel', channel: 'old-verify' },
    { type: 'create_channel', name: 'verify' },
    { type: 'create_channel', name: 'support' },
    { type: 'move_message', message: 'verification', to_channel: 'verify' },
    { type: 'move_panel', message: 'ticket panel', to_channel: 'support' },
  ]);
  assert.deepEqual(result.lines.map((l) => l.status), ['ok', 'ok', 'ok', 'ok', 'ok'], JSON.stringify(result.lines));
  assert.match(result.lines[4].text, /Deleted \*\*old-verify\*\*/);
  assert.ok(!world.guild.channels.cache.has(old.id));

  const verify = [...world.guild.channels.cache.values()].find((c: any) => c.name === 'verify');
  const support = [...world.guild.channels.cache.values()].find((c: any) => c.name === 'support');
  const movedVerify = [...verify.messageStore.values()][0];
  const movedTickets = [...support.messageStore.values()][0];
  assert.match(customIds(movedVerify), /"gs:verify:\d+"/, 'verify button survives the move');
  assert.match(customIds(movedTickets), /"gs:ticket:open"/);
  assert.equal(movedVerify.embeds[0].data.title, '✅ Verification');

  const after = db.getGuild(world.guild.id).posts!;
  assert.equal(after.find((p) => p.kind === 'verification')!.channelId, verify.id);
  assert.equal(after.find((p) => p.kind === 'tickets')!.id, movedTickets.id);
  assert.match(describeAction({ type: 'move_message', message: 'x', to_channel: 'y' } as any), /Move message/);
});

test('other people\'s messages move through a webhook with their name and avatar', async () => {
  const general = addChannel('general');
  const archive = addChannel('archive');
  const msg = fakeMessage(general, { content: 'gg everyone', author: { id: '900000000000000002', username: 'bob', displayName: 'Bob' } });
  const result = await run([{ type: 'move_message', message: msg.url, to_channel: 'archive' }]);
  assert.equal(result.lines[0].status, 'ok', result.lines[0].text);
  const hook = [...archive.webhooks.values()][0];
  assert.equal(hook.sent[0].username, 'Bob');
  assert.equal(hook.sent[0].content, 'gg everyone');
  assert.match(hook.sent[0].avatarURL, /900000000000000002/);
  assert.deepEqual(hook.sent[0].allowedMentions, { parse: [] });
  assert.ok(!general.messageStore.has(msg.id), 'original deleted');

  // The webhook is reused on the next move instead of creating a new one each time.
  const second = fakeMessage(general, { content: 'second one' });
  await run([{ type: 'move_message', message: second.url, to_channel: 'archive' }]);
  assert.equal(archive.webhooks.size, 1);
});

test('copy keeps the original, and empty messages (no Message Content intent) are never deleted', async () => {
  const general = addChannel('general');
  addChannel('archive');
  const keep = fakeMessage(general, { content: 'keep me' });
  const hidden = fakeMessage(general, { content: '' });
  const result = await run([
    { type: 'copy_message', message: keep.url, to_channel: 'archive' },
    { type: 'move_message', message: hidden.url, to_channel: 'archive' },
  ]);
  assert.equal(result.lines[0].status, 'ok');
  assert.match(result.lines[0].text, /^Copied/);
  assert.ok(general.messageStore.has(keep.id));
  assert.equal(result.lines[1].status, 'failed');
  assert.match(result.lines[1].text, /Message Content intent/);
  assert.ok(general.messageStore.has(hidden.id), 'original untouched');
});

test('move_messages moves the newest N in order and bulk-deletes the originals', async () => {
  const general = addChannel('general');
  const archive = addChannel('archive');
  const first = fakeMessage(general, { content: 'one' });
  for (const content of ['two', 'three', 'four']) fakeMessage(general, { content });
  fakeMessage(general, { content: 'joined', system: true });
  const result = await run([{ type: 'move_messages', from_channel: 'general', to_channel: 'archive', count: 3 }]);
  assert.equal(result.lines[0].status, 'ok', result.lines[0].text);
  assert.match(result.lines[0].text, /Moved 3 message/);
  const hook = [...archive.webhooks.values()][0];
  assert.deepEqual(hook.sent.map((p: any) => p.content), ['two', 'three', 'four']);
  assert.equal(general.bulkDeleted, 3);
  assert.deepEqual([...general.messageStore.values()].map((m: any) => m.content), ['one', 'joined']);
  assert.ok(general.messageStore.has(first.id));
});

test('edit_message only touches the bot\'s own messages; delete_message works by title', async () => {
  const { db } = await load();
  const news = addChannel('news');
  await run([{ type: 'send_message', channel: 'news', embed: { title: 'Patch notes', description: 'v1' } }]);
  const userMsg = fakeMessage(news, { content: 'not yours' });
  const result = await run([
    { type: 'edit_message', message: 'Patch notes', embed: { title: 'Patch notes', description: 'v2' } },
    { type: 'edit_message', message: userMsg.url, content: 'hacked' },
  ]);
  assert.equal(result.lines[0].status, 'ok');
  const botMsg = [...news.messageStore.values()].find((m: any) => m.author.id === 'bot-user');
  assert.equal(botMsg.embeds[0].data.description, 'v2');
  assert.equal(result.lines[1].status, 'failed');
  assert.match(result.lines[1].text, /only edit messages I posted/);
  assert.equal(userMsg.content, 'not yours');

  await run([{ type: 'remove_message', message: 'patch notes' }]);
  assert.ok(!news.messageStore.has(botMsg.id));
  assert.equal(db.getGuild(world.guild.id).posts!.some((p) => p.id === botMsg.id), false);
});

test('send_message: pings need approval, link buttons are https only', async () => {
  const { normalizeActions, isActionDestructive } = await load();
  const announcements = addChannel('announcements');
  const { actions } = normalizeActions([
    { type: 'announce', channel: 'announcements', content: 'New channels!', ping: 'everyone', buttons: [{ label: 'Site', url: 'https://example.com' }, { label: 'Bad', url: 'javascript:alert(1)' }] },
    { type: 'send_message', channel: 'announcements', content: 'quiet' },
  ]);
  assert.equal(actions[0].type, 'send_message');
  assert.equal(isActionDestructive(actions[0], new Set()), true);
  assert.equal(isActionDestructive(actions[1], new Set()), false);

  const skipped = await run(actions, false);
  assert.deepEqual(skipped.lines.map((l) => l.status), ['skipped', 'ok']);
  assert.deepEqual(announcements.sent[0].allowedMentions, { parse: [] });

  const approved = await run([actions[0]], true);
  assert.equal(approved.lines[0].status, 'ok');
  const payload = announcements.sent[1];
  assert.equal(payload.content, '@everyone New channels!');
  assert.deepEqual(payload.allowedMentions, { parse: ['everyone'] });
  const buttons = payload.components[0].toJSON().components;
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].url, 'https://example.com');
  assert.ok(approved.warnings.some((w) => w.includes('https')));
});
