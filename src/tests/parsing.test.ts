import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJson } from '../ai/json';
import { parsePlan } from '../ai/planner';
import { normalizeActions, orderActions } from '../discord/actions';
import { botInviteUrl, findCatalogBot, parseClientId } from '../discord/bots';
import { isDangerous, resolvePermissions } from '../discord/permissions';
import { loose, resolveColor } from '../discord/resolve';
import { Semaphore } from '../ai/queue';

test('extractJson handles fences, think blocks, chatter and trailing commas', () => {
  assert.deepEqual(extractJson('```json\n{"a": 1,}\n```'), { a: 1 });
  assert.deepEqual(extractJson('<think>hmm {not json}</think>Sure! Here you go: {"reply":"hi","actions":[]} hope it helps'), { reply: 'hi', actions: [] });
  assert.deepEqual(extractJson('[{"type":"create_role","name":"A"}]'), [{ type: 'create_role', name: 'A' }]);
  assert.throws(() => extractJson('no json here at all'));
});

test('extractJson recovers a reply that was cut off mid-array', () => {
  const truncated = '{"reply":"ok","actions":[{"type":"create_role","name":"A"},{"type":"create_role","name":"B"},{"type":"create_ch';
  const value = extractJson(truncated) as any;
  assert.equal(value.actions.length, 2);
  assert.equal(value.actions[1].name, 'B');
});

test('extractJson keeps braces inside strings intact', () => {
  const value = extractJson('{"reply":"use {user} and } here","actions":[]}') as any;
  assert.equal(value.reply, 'use {user} and } here');
});

test('normalizeActions accepts the shapes models actually produce', () => {
  const { actions, invalid } = normalizeActions([
    { type: 'create_role', name: 'Mod', permissions: 'KickMembers', hoist: 'true' },
    { action: 'create_channel', type: 'voice', name: 'Lounge', user_limit: '5' },
    { type: 'create_voice_channel', name: 'Squad' },
    { type: 'create_channel', channel_type: 'category', name: 'INFO' },
    { tool: 'post_message', params: { channel: 'rules', content: 'hi' } },
    { type: 'remove_role', role: 'Muted', users: ['123456789012345678'] },
    { type: 'Delete-Channel', channel: 'old' },
    { type: 'teleport', where: 'moon' },
    { type: '__proto__', name: 'x' },
    { action: 'constructor', name: 'x' },
    { type: 'create_role' },
  ]);
  assert.equal(actions.length, 7);
  assert.equal(invalid.length, 4);
  const [role, lounge, squad, info, msg, remove, del] = actions as any[];
  assert.deepEqual(role.permissions, ['KickMembers']);
  assert.equal(role.hoist, true);
  assert.equal(lounge.type, 'create_channel');
  assert.equal(lounge.channel_type, 'voice');
  assert.equal(lounge.user_limit, 5);
  assert.equal(squad.channel_type, 'voice');
  assert.equal(info.type, 'create_category');
  assert.equal(msg.type, 'send_message');
  assert.equal(msg.content, 'hi');
  assert.equal(remove.type, 'assign_role');
  assert.equal(remove.remove, true);
  assert.equal(del.type, 'delete_channel');
  assert.match(invalid[0].error, /unknown action/);
  assert.equal(invalid[3].type, 'create_role');
});

test('orderActions puts roles and categories before the channels that use them', () => {
  const { actions } = normalizeActions([
    { type: 'send_message', channel: 'rules', content: 'x' },
    { type: 'create_channel', name: 'rules', category: 'info' },
    { type: 'create_category', key: 'info', name: 'INFO' },
    { type: 'create_role', name: 'Mod' },
    { type: 'delete_channel', channel: 'old' },
  ]);
  assert.deepEqual(
    orderActions(actions).map((a) => a.type),
    ['delete_channel', 'create_role', 'create_category', 'create_channel', 'send_message'],
  );
});

test('parsePlan unwraps bare arrays and nested plans', () => {
  assert.equal(parsePlan('[{"type":"create_role","name":"A"}]').actions.length, 1);
  const nested = parsePlan('{"plan":{"reply":"yo","actions":[{"type":"create_role","name":"A"}]}}');
  assert.equal(nested.reply, 'yo');
  assert.equal(nested.actions.length, 1);
  assert.ok(parsePlan('lol').error);
});

test('permission names resolve from many spellings', () => {
  const r = resolvePermissions(['VIEW_CHANNEL', 'send messages', 'manage_server', 'timeout', 'Speak', 'bogus']);
  assert.deepEqual(r.names, ['ViewChannel', 'SendMessages', 'ManageGuild', 'ModerateMembers', 'Speak']);
  assert.deepEqual(r.unknown, ['bogus']);
  assert.equal(isDangerous(resolvePermissions(['SendMessages']).bits), false);
  assert.equal(isDangerous(resolvePermissions(['Administrator']).bits), true);
});

test('colors and loose matching', () => {
  assert.equal(resolveColor('#ff0000'), 0xff0000);
  assert.equal(resolveColor('0f0'), 0x00ff00);
  assert.equal(resolveColor('dark purple'), 0x71368a);
  assert.equal(resolveColor('nope'), undefined);
  assert.equal(loose('💬・General-Chat'), loose('general chat'));
});

test('bot invite helpers', () => {
  assert.equal(findCatalogBot('carl bot')?.name, 'Carl-bot');
  assert.equal(findCatalogBot('mee6')?.clientId, '159985870458322944');
  assert.deepEqual(parseClientId('https://discord.com/oauth2/authorize?client_id=123456789012345678&permissions=8&scope=bot'), {
    clientId: '123456789012345678',
    permissions: '8',
  });
  assert.equal(parseClientId('hello'), undefined);
  const url = new URL(botInviteUrl('123456789012345678', '987654321098765432'));
  assert.equal(url.searchParams.get('guild_id'), '987654321098765432');
  assert.equal(url.searchParams.get('disable_guild_select'), 'true');
  assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
});

test('semaphore queues and reports positions', async () => {
  const sem = new Semaphore(1);
  const order: string[] = [];
  const positions: number[] = [];
  const release1 = await sem.acquire();
  const second = sem.acquire((p) => positions.push(p)).then((release) => {
    order.push('second');
    release();
  });
  const third = sem.acquire((p) => positions.push(p * 10)).then((release) => {
    order.push('third');
    release();
  });
  assert.equal(sem.queued, 2);
  order.push('first');
  release1();
  await Promise.all([second, third]);
  assert.deepEqual(order, ['first', 'second', 'third']);
  assert.deepEqual(positions, [1, 20, 10]);
});
