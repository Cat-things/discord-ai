import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { fakeChannel, fakeGuild } from './fakes';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-exec-'));
process.env.FAL_KEY = ''; // keep the test offline even if a real .env has a fal key

// Bot invite verification calls discord.com; keep tests offline.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  if (String(input).includes('discord.com')) return new Response('{}', { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

async function load() {
  const { executePlan, isActionDestructive, plannedNames } = await import('../discord/executor');
  const { normalizeActions, orderActions } = await import('../discord/actions');
  const db = await import('../storage/db');
  return { executePlan, isActionDestructive, plannedNames, normalizeActions, orderActions, db };
}

const findChannel = (guild: any, name: string) => [...guild.channels.cache.values()].find((c: any) => c.name === name);
const findRole = (guild: any, name: string) => [...guild.roles.cache.values()].find((r: any) => r.name === name);

let world: ReturnType<typeof fakeGuild>;
beforeEach(() => {
  world = fakeGuild({ botAdmin: false });
});

test('a full build plan creates the right structure and permissions', async () => {
  const { executePlan, normalizeActions, orderActions, db } = await load();
  const { guild, actor } = world;
  const old = fakeChannel(guild, { name: 'old-chat' });
  guild.channels.cache.set(old.id, old);
  const { actions, invalid } = normalizeActions([
    { type: 'send_message', channel: 'rules', embed: { title: 'Rules', description: '1. Be nice @everyone' } },
    { type: 'create_channel', key: 'rules', name: '📜・rules', category: 'info', read_only: true, allowed_roles: ['mod'] },
    { type: 'create_category', key: 'info', name: '📌 INFO' },
    { type: 'create_category', key: 'staff', name: '🛡️ STAFF', private: true, allowed_roles: ['mod'] },
    { type: 'create_channel', name: 'mod-chat', category: 'staff', private: true, allowed_roles: ['mod'] },
    { type: 'create_channel', name: 'Gaming', channel_type: 'voice', category: 'Voice Rooms', user_limit: 150 },
    { type: 'create_channel', name: 'news', channel_type: 'announcement', category: 'info' },
    { type: 'create_role', key: 'mod', name: 'Moderator', color: '#e67e22', hoist: true, permissions: ['KickMembers', 'BanMembers', 'ManageMessages'] },
    { type: 'create_role', key: 'member', name: 'Member', color: 'blue' },
    { type: 'setup_welcome', channel: 'rules', message: 'Hey {user}, welcome to {server}!' },
    { type: 'setup_autorole', roles: ['member'] },
    { type: 'create_role_menu', channel: 'rules', title: 'Pick roles', roles: [{ role: 'member', emoji: '🔵' }] },
    { type: 'create_automod_rule', name: 'No spam', trigger: 'mention_spam', mention_limit: 8, actions: [{ type: 'timeout', duration_seconds: 600 }, { type: 'alert', channel: 'mod-chat' }] },
    { type: 'create_automod_rule', name: 'Presets', trigger: 'keyword_preset', actions: [{ type: 'timeout' }] },
    { type: 'recommend_bots', bots: [{ name: 'MEE6', reason: 'levels' }, { name: 'SomeUnknownBot' }] },
    { type: 'delete_channel', channel: 'old-chat' },
  ]);
  assert.equal(invalid.length, 0);
  const result = await executePlan({ guild, actor: actor as any, actions: orderActions(actions), allowDestructive: true });

  const failed = result.lines.filter((l) => l.status !== 'ok');
  assert.deepEqual(failed, [], JSON.stringify(failed));
  assert.ok(!guild.channels.cache.has(old.id), 'approved delete ran');

  // Roles: created highest first -> Moderator ends up above Member; bot can't grant BanMembers it lacks.
  const mod = findRole(guild, 'Moderator');
  const member = findRole(guild, 'Member');
  assert.ok(mod.position > member.position);
  assert.equal(mod.createOpts.colors.primaryColor, 0xe67e22);
  assert.equal(mod.createOpts.permissions, PermissionFlagsBits.KickMembers);
  assert.ok(result.warnings.some((w) => w.includes('BanMembers')));
  assert.equal(member.createOpts.colors.primaryColor, 0x3498db);

  // Read-only rules channel inside the INFO category.
  const info = findChannel(guild, '📌 INFO');
  const rules = findChannel(guild, '📜・rules');
  assert.equal(rules.parentId, info.id);
  const everyoneOw = rules.permissionOverwrites.cache.get(guild.id);
  assert.ok(everyoneOw.deny.has('SendMessages'));
  assert.ok(rules.permissionOverwrites.cache.get(mod.id).allow.has('SendMessages'));

  // Private staff category + channel; the non-admin bot keeps access to private channels.
  const staff = findChannel(guild, '🛡️ STAFF');
  assert.ok(staff.permissionOverwrites.cache.get(guild.id).deny.has('ViewChannel'));
  assert.ok(staff.permissionOverwrites.cache.get(mod.id).allow.has('ViewChannel'));
  assert.equal(staff.permissionOverwrites.cache.get('bot-user').type, OverwriteType.Member);
  const modChat = findChannel(guild, 'mod-chat');
  assert.ok(modChat.permissionOverwrites.cache.get(guild.id).deny.has('ViewChannel'));

  // Missing category auto-created, voice user limit clamped, announcement downgraded without Community.
  const voiceRooms = findChannel(guild, 'Voice Rooms');
  assert.equal(voiceRooms.type, ChannelType.GuildCategory);
  const gaming = findChannel(guild, 'Gaming');
  assert.equal(gaming.type, ChannelType.GuildVoice);
  assert.equal(gaming.createOpts.userLimit, 99);
  assert.equal(findChannel(guild, 'news').type, ChannelType.GuildText);

  // Message sent without pinging anyone.
  assert.deepEqual(rules.sent[0].allowedMentions, { parse: [] });
  assert.equal(rules.sent[0].embeds[0].data.title, 'Rules');
  assert.ok(rules.sent[1].components[0].components[0].data.custom_id.startsWith('gs:rr:'));

  // Bot-side features stored.
  const settings = db.getGuild(guild.id);
  assert.equal(settings.welcome?.channelId, rules.id);
  assert.deepEqual(settings.autorole?.roleIds, [member.id]);

  // AutoMod: timeout kept on mention spam, dropped on preset rule, alert goes to mod-chat.
  const [mention, preset] = guild.automod;
  assert.equal(mention.triggerMetadata.mentionTotalLimit, 8);
  assert.deepEqual(mention.actions.map((a: any) => a.type), [3, 2]);
  assert.equal(mention.actions[1].metadata.channel, modChat.id);
  assert.deepEqual(preset.actions.map((a: any) => a.type), [1]);
  assert.equal(preset.triggerMetadata.presets.length, 3, 'defaults to all three presets');

  // Bot invites: known bot gets a server-preselected link, unknown bot gets a warning.
  assert.equal(result.links.length, 1);
  assert.match(result.links[0].url, new RegExp(`guild_id=${guild.id}`));
  assert.equal(result.links[0].label, 'MEE6');
  assert.ok(result.warnings.some((w) => w.includes('SomeUnknownBot')));
});

test('without approval, destructive steps are skipped and safe ones still run', async () => {
  const { executePlan, normalizeActions } = await load();
  const { guild, actor } = world;
  const old = fakeChannel(guild, { name: 'old-chat' });
  guild.channels.cache.set(old.id, old);
  const { actions } = normalizeActions([
    { type: 'delete_channel', channel: 'old-chat' },
    { type: 'create_role', name: 'Mod', permissions: ['BanMembers'] },
    { type: 'create_role', name: 'Fan' },
  ]);
  const result = await executePlan({ guild, actor: actor as any, actions, allowDestructive: false });
  assert.deepEqual(result.lines.map((l) => l.status), ['skipped', 'skipped', 'ok']);
  assert.ok(guild.channels.cache.has(old.id));
  assert.equal(findRole(guild, 'Mod'), undefined);
  assert.ok(findRole(guild, 'Fan'));
});

test('destructive classification: edits on things the plan creates are safe, existing ones are not', async () => {
  const { isActionDestructive, plannedNames, normalizeActions } = await load();
  const { guild } = world;
  const { actions } = normalizeActions([
    { type: 'create_channel', key: 'lobby', name: 'lobby' },
    { type: 'edit_channel', channel: 'lobby', topic: 'hi' },
    { type: 'set_permissions', channel: 'Old Mod', target: '@everyone', deny: ['SendMessages'] },
    { type: 'create_role', name: 'Boss', permissions: ['Administrator'] },
    { type: 'create_role', name: 'Fan' },
    { type: 'delete_role', role: 'Old Mod' },
    { type: 'setup_welcome', channel: 'lobby', message: 'hi' },
  ]);
  const planned = plannedNames(guild, actions);
  assert.deepEqual(
    actions.map((a) => isActionDestructive(a, planned)),
    [false, false, true, true, false, true, false],
  );
});

test('safety rails: no dangerous auto roles, no editing roles above the requester', async () => {
  const { executePlan, normalizeActions } = await load();
  const { guild, oldMod, admins } = world;
  const lowAdmin = { id: 'someone', roles: { highest: { position: 4 } } };
  const { actions } = normalizeActions([
    { type: 'setup_autorole', roles: ['Admins'] },
    { type: 'create_verification', channel: 'x', role: 'Admins' },
    { type: 'edit_role', role: 'Old Mod', name: 'Hacked' },
    { type: 'delete_role', role: 'Owner' },
    { type: 'assign_role', role: 'Admins', everyone: 'all' },
  ]);
  const x = fakeChannel(guild, { name: 'x' });
  guild.channels.cache.set(x.id, x);
  const result = await executePlan({ guild, actor: lowAdmin as any, actions, allowDestructive: true });
  assert.deepEqual(result.lines.map((l) => l.status), ['failed', 'failed', 'failed', 'failed', 'failed']);
  assert.match(result.lines[0].text, /moderator\/admin permissions/);
  assert.match(result.lines[2].text, /at or above your highest role/);
  assert.match(result.lines[3].text, /above my highest role/);
  assert.equal(oldMod.name, 'Old Mod');
  assert.ok(guild.roles.cache.has(admins.id));
});

test('community + onboarding + server edit flow', async () => {
  const { executePlan, normalizeActions, orderActions } = await load();
  world = fakeGuild({ botAdmin: true });
  const { guild, actor } = world;
  const { actions } = normalizeActions([
    { type: 'setup_onboarding', default_channels: ['general'], prompts: [{ title: 'What do you play?', options: [{ title: 'Minecraft', emoji: '⛏️', roles: ['Minecraft'] }, { title: 'Nothing valid' }] }] },
    { type: 'enable_community', rules_channel: 'rules', updates_channel: 'mod-updates' },
    { type: 'create_channel', name: 'rules' },
    { type: 'create_channel', name: 'mod-updates', private: true },
    ...['general', 'memes', 'media', 'clips', 'help', 'off-topic', 'bots'].map((name) => ({ type: 'create_channel', name })),
    { type: 'create_role', name: 'Minecraft' },
    { type: 'edit_server', description: 'Best server', verification_level: 'medium', default_notifications: 'only mentions', afk_timeout: 500, icon_prompt: 'a cat' },
  ]);
  const result = await executePlan({ guild, actor: actor as any, actions: orderActions(actions), allowDestructive: true });
  assert.deepEqual(result.lines.filter((l) => l.status !== 'ok'), []);
  assert.ok(guild.features.includes('COMMUNITY'));
  const communityEdit = guild.edits[0];
  assert.equal(communityEdit.explicitContentFilter, 2);
  assert.ok(communityEdit.verificationLevel >= 1);
  assert.equal(guild.onboarding.prompts.length, 1);
  assert.equal(guild.onboarding.prompts[0].options.length, 1);
  assert.ok(guild.onboarding.defaultChannels.length >= 7);
  const serverEdit = guild.edits[1];
  assert.equal(serverEdit.description, 'Best server');
  assert.equal(serverEdit.verificationLevel, 2);
  assert.equal(serverEdit.defaultMessageNotifications, 1);
  assert.equal(serverEdit.afkTimeout, 300);
  assert.ok(result.warnings.some((w) => w.includes('fal.ai')), 'icon skipped without a fal key');
  assert.ok(result.warnings.some((w) => w.includes('Nothing valid')));
});
