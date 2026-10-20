import {
  ChannelType,
  DiscordAPIError,
  EmbedType,
  Guild,
  GuildBasedChannel,
  GuildTextBasedChannel,
  Message,
  NewsChannel,
  StageChannel,
  TextChannel,
  VoiceChannel,
  Webhook,
} from 'discord.js';
import { BotPost, getGuild, updateGuild } from '../storage/db';
import { Refused } from './errors';
import { loose } from './resolve';

export type PostKind = BotPost['kind'];
export type MessageTarget = TextChannel | NewsChannel | VoiceChannel | StageChannel;

const TARGET_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const MAX_POSTS = 100;
const DAY = 24 * 60 * 60_000;

export function isMessageTarget(channel: GuildBasedChannel | undefined | null): channel is MessageTarget {
  return !!channel && TARGET_TYPES.has(channel.type);
}

/* ------------------------------------------------------------------------------------------------ */
/* Tracking the bot's own posts                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export function trackPost(guildId: string, post: Omit<BotPost, 'at'>): void {
  updateGuild(guildId, (g) => {
    g.posts = [{ ...post, title: post.title.slice(0, 100), at: new Date().toISOString() }, ...(g.posts ?? []).filter((p) => p.id !== post.id)].slice(0, MAX_POSTS);
  });
}

export function untrackPost(guildId: string, messageId: string): void {
  updateGuild(guildId, (g) => {
    g.posts = (g.posts ?? []).filter((p) => p.id !== messageId);
  });
}

function retrackPost(guildId: string, oldId: string, moved: Message): void {
  const old = getGuild(guildId).posts?.find((p) => p.id === oldId);
  if (!old) return;
  untrackPost(guildId, oldId);
  trackPost(guildId, { id: moved.id, channelId: moved.channelId, kind: old.kind, title: old.title });
}

/** Panel type from the buttons/menus the bot put on a message. */
export function kindOfMessage(msg: Message): PostKind | undefined {
  const ids = JSON.stringify(msg.components.map((c) => c.toJSON()));
  if (ids.includes('"gs:verify:')) return 'verification';
  if (ids.includes('"gs:ticket:open"')) return 'tickets';
  if (ids.includes('"gs:rr:') || ids.includes('"gs:rrsel"')) return 'role_menu';
  return undefined;
}

/** "the verification panel" → verification, "support tickets" → tickets, "self roles" → role_menu. */
export function kindFromRef(ref: string): PostKind | undefined {
  const s = loose(ref);
  if (s.includes('verif')) return 'verification';
  if (s.includes('ticket') || s.includes('support')) return 'tickets';
  if (s.includes('rolemenu') || s.includes('selfrole') || s.includes('reactionrole') || s.includes('rolepicker') || s === 'roles') return 'role_menu';
  return undefined;
}

export function titleOf(msg: { content?: string | null; embeds?: { title?: string | null }[] }): string {
  return (msg.embeds?.[0]?.title || msg.content || 'message').replace(/\s+/g, ' ').slice(0, 80);
}

/* ------------------------------------------------------------------------------------------------ */
/* Finding messages                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

/** Pulls a channel + message id out of a message link or Discord's "channelId-messageId" copy format. */
export function parseMessageRef(ref: string): { channelId: string; messageId: string } | undefined {
  const link = /discord(?:app)?\.com\/channels\/\d+\/(\d{17,20})\/(\d{17,20})/.exec(ref);
  if (link) return { channelId: link[1], messageId: link[2] };
  const pair = /^(\d{17,20})[-/:](\d{17,20})$/.exec(ref.trim());
  if (pair) return { channelId: pair[1], messageId: pair[2] };
  return undefined;
}

function findTracked(guild: Guild, ref: string): BotPost | undefined {
  const posts = (getGuild(guild.id).posts ?? []).filter((p) => guild.channels.cache.has(p.channelId));
  const trimmed = ref.trim();
  const byId = posts.find((p) => p.id === trimmed);
  if (byId) return byId;
  const wanted = loose(trimmed);
  if (wanted) {
    const byTitle = posts.find((p) => loose(p.title) === wanted) ?? posts.find((p) => wanted.length >= 4 && loose(p.title).includes(wanted));
    if (byTitle) return byTitle;
  }
  const kind = kindFromRef(trimmed);
  return kind ? posts.find((p) => p.kind === kind) : undefined;
}

/**
 * Cheap, offline guess of which channel a message ref lives in (link or tracked post).
 * Used to make sure a plan never deletes a channel before moving messages out of it.
 */
export function sourceChannelOf(guild: Guild, ref: string): string | undefined {
  return parseMessageRef(ref)?.channelId ?? findTracked(guild, ref)?.channelId;
}

async function fetchIn(channel: GuildBasedChannel | undefined, messageId: string): Promise<Message | undefined> {
  if (!channel || !channel.isTextBased()) return undefined;
  return (channel as GuildTextBasedChannel).messages.fetch(messageId).catch(() => undefined);
}

/** Older panels from before tracking existed: look through recent bot messages for the right buttons. */
async function scanForPanel(guild: Guild, kind: PostKind): Promise<Message | undefined> {
  const channels = [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).slice(0, 40);
  for (const channel of channels) {
    const recent = await (channel as TextChannel).messages.fetch({ limit: 50 }).catch(() => undefined);
    const hit = recent?.find((m) => m.author.id === guild.client.user.id && kindOfMessage(m) === kind);
    if (hit) {
      trackPost(guild.id, { id: hit.id, channelId: hit.channelId, kind, title: titleOf(hit) });
      return hit;
    }
  }
  return undefined;
}

/**
 * Finds a message from whatever the AI or admin gave us: a message link, "channelId-messageId",
 * a tracked post id or title, or a panel type like "verification" / "tickets" / "role menu".
 */
export async function resolveMessage(guild: Guild, ref: string): Promise<Message> {
  const parsed = parseMessageRef(ref);
  if (parsed) {
    const msg = await fetchIn(guild.channels.cache.get(parsed.channelId), parsed.messageId);
    if (msg) return msg;
    throw new Refused(`Couldn't find that message (deleted, or I can't see that channel).`);
  }
  const tracked = findTracked(guild, ref);
  if (tracked) {
    const msg = await fetchIn(guild.channels.cache.get(tracked.channelId), tracked.id);
    if (msg) return msg;
    untrackPost(guild.id, tracked.id);
  }
  const kind = kindFromRef(ref);
  if (kind) {
    const found = await scanForPanel(guild, kind);
    if (found) return found;
  }
  throw new Refused(`Message "${ref}" not found. Use a message link (right-click the message → Copy Message Link) or a title from bot_messages.`);
}

/* ------------------------------------------------------------------------------------------------ */
/* Moving                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

const hookCache = new Map<string, Webhook>();

/** One reusable webhook per channel, so moved messages keep their author's name and avatar. */
async function moverWebhook(target: MessageTarget): Promise<Webhook> {
  const cached = hookCache.get(target.id);
  if (cached) return cached;
  const botId = target.client.user.id;
  const existing = (await target.fetchWebhooks()).find((w) => w.owner?.id === botId && !!w.token);
  const hook = existing ?? (await target.createWebhook({ name: 'GuildSmith Mover', reason: 'Moving messages' }));
  hookCache.set(target.id, hook);
  return hook;
}

/** Discord rejects webhook names containing these words. */
function webhookName(name: string): string {
  const cleaned = name.replace(/discord|clyde/gi, '').trim().slice(0, 80);
  return cleaned.length >= 1 ? cleaned : 'Moved message';
}

export interface MoveOutcome {
  moved: Message;
  deletedOriginal: boolean;
  note?: string;
}

/** True for messages that come back empty because the Message Content intent is off in the Developer Portal. */
function looksHidden(msg: Message): boolean {
  return !msg.content && !msg.embeds.length && !msg.attachments.size && !msg.stickers.size && !msg.poll;
}

/**
 * Discord has no "move message" API, so this reposts the message in the target channel and then
 * deletes the original. The bot's own messages are reposted as-is, buttons included, so verification,
 * ticket and role panels keep working. Other people's messages go through a webhook with their name
 * and avatar. The original is only deleted once the copy was posted successfully.
 */
export async function moveMessage(guild: Guild, msg: Message, target: MessageTarget, opts: { keepOriginal?: boolean } = {}): Promise<MoveOutcome> {
  if (msg.system) throw new Refused('System messages (joins, pins, boosts...) can\'t be moved.');
  if (msg.channelId === target.id) throw new Refused(`That message is already in #${target.name}.`);
  const mine = msg.author.id === guild.client.user.id && !msg.webhookId;
  if (!mine && looksHidden(msg)) {
    throw new Refused(
      'That message came back empty, so the Message Content intent is probably off. Turn on MESSAGE CONTENT INTENT in the Developer Portal → Bot, then try again. (The original was not touched.)',
    );
  }

  const files = msg.attachments.map((a) => ({ attachment: a.url, name: a.name }));
  const notes: string[] = [];
  if (msg.stickers.size) notes.push('stickers can\'t be reposted');
  if (msg.poll) notes.push('polls can\'t be reposted');
  let moved: Message;

  if (mine) {
    moved = await target.send({
      content: msg.content || undefined,
      embeds: msg.embeds.map((e) => e.toJSON()),
      components: msg.components.map((c) => c.toJSON()) as never,
      files,
      allowedMentions: { parse: [] },
    });
  } else {
    const hook = await moverWebhook(target);
    const author = msg.member?.displayName ?? msg.author.displayName ?? msg.author.username;
    const payload = {
      content: msg.content || (files.length ? undefined : '*(empty message)*'),
      avatarURL: (msg.member ?? msg.author).displayAvatarURL({ size: 256 }),
      // Link previews regenerate from the content; only real (rich) embeds need copying.
      embeds: msg.embeds.filter((e) => e.data.type === EmbedType.Rich || e.data.type === undefined).map((e) => e.toJSON()),
      files,
      allowedMentions: { parse: [] as never[] },
    };
    try {
      moved = await hook.send({ ...payload, username: webhookName(author) });
    } catch (err) {
      if (!(err instanceof DiscordAPIError) || err.code !== 50035) throw err;
      moved = await hook.send({ ...payload, username: 'Moved message' });
    }
  }

  let deletedOriginal = false;
  if (!opts.keepOriginal) {
    try {
      await msg.delete();
      deletedOriginal = true;
    } catch (err) {
      notes.push(`couldn't delete the original (${err instanceof Error ? err.message.split('\n')[0] : err})`);
    }
  }
  if (deletedOriginal) retrackPost(guild.id, msg.id, moved);
  else if (mine) {
    const old = getGuild(guild.id).posts?.find((p) => p.id === msg.id);
    if (old) trackPost(guild.id, { id: moved.id, channelId: moved.channelId, kind: old.kind, title: old.title });
  }
  return { moved, deletedOriginal, note: notes.length ? notes.join('; ') : undefined };
}

export interface BulkOutcome {
  moved: number;
  failed: number;
  deleted: number;
  notes: string[];
}

/** Moves the newest `count` messages (optionally only from one author) in chronological order. */
export async function moveRecentMessages(
  guild: Guild,
  source: GuildTextBasedChannel,
  target: MessageTarget,
  count: number,
  opts: { authorId?: string; keepOriginal?: boolean } = {},
): Promise<BulkOutcome> {
  if (source.id === target.id) throw new Refused('Source and target channel are the same.');
  const limit = Math.max(1, Math.min(100, Math.round(count)));
  const fetched = await source.messages.fetch({ limit: 100 });
  const picked = [...fetched.values()]
    .filter((m) => !m.system && (!opts.authorId || m.author.id === opts.authorId))
    .slice(0, limit)
    .reverse();
  if (!picked.length) throw new Refused(`No movable messages found in #${source.name}.`);

  const outcome: BulkOutcome = { moved: 0, failed: 0, deleted: 0, notes: [] };
  const done: Message[] = [];
  for (const msg of picked) {
    try {
      const r = await moveMessage(guild, msg, target, { keepOriginal: true });
      done.push(msg);
      outcome.moved++;
      if (r.note) outcome.notes.push(r.note);
    } catch (err) {
      outcome.failed++;
      outcome.notes.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (!opts.keepOriginal && done.length) {
    const recent = done.filter((m) => Date.now() - m.createdTimestamp < 14 * DAY - 60_000);
    const old = done.filter((m) => !recent.includes(m));
    try {
      if (recent.length >= 2 && 'bulkDelete' in source) {
        const removed = await (source as TextChannel).bulkDelete(recent.map((m) => m.id), true);
        outcome.deleted += removed.size;
      } else {
        old.push(...recent);
      }
    } catch {
      old.push(...recent);
    }
    for (const m of old) {
      if (await m.delete().then(() => true, () => false)) outcome.deleted++;
    }
    for (const m of done) untrackPost(guild.id, m.id);
    if (outcome.deleted < done.length) outcome.notes.push(`${done.length - outcome.deleted} original(s) couldn't be deleted`);
  }
  outcome.notes = [...new Set(outcome.notes)];
  return outcome;
}
