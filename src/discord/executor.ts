import {
  ActionRowBuilder,
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  AutoModerationRuleTriggerType,
  ButtonBuilder,
  ButtonStyle,
  CategoryChannel,
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  Guild,
  GuildBasedChannel,
  GuildChannel,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildMember,
  GuildOnboardingMode,
  GuildOnboardingPromptType,
  GuildVerificationLevel,
  Locale,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  PermissionsString,
  Role,
  StringSelectMenuBuilder,
} from 'discord.js';
import { falKeyFor } from '../ai/guild';
import { generateImage } from '../ai/images';
import { config } from '../config';
import { log } from '../logger';
import { updateGuild } from '../storage/db';
import { Action, ActionOf, ActionType, DESTRUCTIVE_TYPES } from './actions';
import { BOT_CATALOG, botInviteUrl, findCatalogBot, lookupApplication } from './bots';
import { isDangerous, resolvePermissions } from './permissions';
import { fetchImage, newKeys, PlanKeys, resolveChannel, resolveColor, resolveRole } from './resolve';

export const BRAND_COLOR = 0x5865f2;

export interface BotLink {
  label: string;
  url: string;
  note?: string;
}

export interface ResultLine {
  status: 'ok' | 'failed' | 'skipped';
  text: string;
}

export interface ExecResult {
  lines: ResultLine[];
  created: { kind: string; id: string; name: string }[];
  changed: string[];
  links: BotLink[];
  warnings: string[];
}

interface Ctx {
  guild: Guild;
  me: GuildMember;
  actor: GuildMember;
  keys: PlanKeys;
  result: ExecResult;
}

class Refused extends Error {}

/* ------------------------------------------------------------------------------------------------ */
/* Destructive classification                                                                       */
/* ------------------------------------------------------------------------------------------------ */

/** Keys and names of things this plan creates, so edits to them don't count as destructive. */
export function plannedNames(guild: Guild, actions: Action[]): Set<string> {
  const names = new Set<string>();
  for (const a of actions) {
    if (a.type !== 'create_channel' && a.type !== 'create_category' && a.type !== 'create_role') continue;
    if (a.key) names.add(a.key.toLowerCase());
    const exists =
      a.type === 'create_role'
        ? guild.roles.cache.some((r) => r.name.toLowerCase() === a.name.toLowerCase())
        : guild.channels.cache.some((c) => c.name.toLowerCase() === a.name.toLowerCase());
    if (!exists) names.add(a.name.toLowerCase());
  }
  return names;
}

export function isActionDestructive(a: Action, planned: Set<string>): boolean {
  const own = (ref?: string | null) => !!ref && planned.has(ref.toLowerCase().replace(/^#/, ''));
  switch (a.type) {
    case 'create_role':
      return isDangerous(resolvePermissions(a.permissions).bits);
    case 'edit_channel':
    case 'set_permissions':
      return !own(a.channel);
    case 'edit_role':
      return !own(a.role) || isDangerous(resolvePermissions([...(a.permissions ?? []), ...(a.add_permissions ?? [])]).bits);
    default:
      return DESTRUCTIVE_TYPES.has(a.type);
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Helpers                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export function explainError(err: unknown): string {
  if (err instanceof Refused) return err.message;
  if (err instanceof DiscordAPIError) {
    const hints: Record<number, string> = {
      50013: 'Missing permissions. Give me Administrator and drag my role to the top of the role list.',
      30005: 'This server hit the 250 role limit.',
      30013: 'This server hit the 500 channel limit.',
      30031: 'Discord wants a unique name here.',
      50024: 'That action is not allowed on this channel type.',
      50074: 'Discord won\'t delete a channel that is required for Community servers (rules / updates).',
      10003: 'That channel no longer exists.',
      10011: 'That role no longer exists.',
    };
    return `${hints[Number(err.code)] ?? 'Discord said no'} (${err.code}: ${err.message.split('\n')[0].slice(0, 180)})`;
  }
  return err instanceof Error ? err.message : String(err);
}

const truncate = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

function botBits(ctx: Ctx): bigint {
  return ctx.me.permissions.bitfield;
}

/** A non-admin bot can't hand out permissions it doesn't have itself; strip them and warn. */
function limitToBot(ctx: Ctx, bits: bigint, where: string): bigint {
  if (ctx.me.permissions.has('Administrator')) return bits;
  const missing = bits & ~botBits(ctx);
  if (missing) {
    ctx.result.warnings.push(`${where}: skipped ${new PermissionsBitField(missing).toArray().join(', ')} (I don't have those myself).`);
  }
  return bits & botBits(ctx);
}

function warnUnknownPerms(ctx: Ctx, unknown: string[], where: string): void {
  if (unknown.length) ctx.result.warnings.push(`${where}: unknown permission(s) ignored: ${unknown.join(', ')}`);
}

function needRole(ctx: Ctx, ref: string | undefined, purpose: string): Role {
  const role = resolveRole(ctx.guild, ctx.keys, ref);
  if (!role) throw new Refused(`Role "${ref}" not found (${purpose}).`);
  return role;
}

function needChannel(ctx: Ctx, ref: string | undefined | null, want: 'any' | 'category' | 'notCategory' = 'any'): GuildBasedChannel {
  const channel = resolveChannel(ctx.guild, ctx.keys, ref, want);
  if (!channel) throw new Refused(`Channel "${ref}" not found.`);
  return channel;
}

function needTextChannel(ctx: Ctx, ref: string) {
  const ch = needChannel(ctx, ref, 'notCategory');
  if (!ch.isTextBased() || !('send' in ch)) throw new Refused(`#${ch.name} is not a channel I can post messages in.`);
  return ch;
}

/** Mirrors Discord's own rule: admins can't manage roles at or above their highest role (owner excepted). */
function assertCanManageRole(ctx: Ctx, role: Role, verb: string): void {
  if (role.managed) throw new Refused(`@${role.name} is managed by an integration/bot and can't be ${verb}.`);
  if (role.position >= ctx.me.roles.highest.position && role.id !== ctx.guild.id) {
    throw new Refused(`@${role.name} is above my highest role, so I can't ${verb.replace(/ed$/, '')} it. Drag my role higher in Server Settings → Roles.`);
  }
  if (ctx.actor.id !== ctx.guild.ownerId && role.id !== ctx.guild.id && role.position >= ctx.actor.roles.highest.position) {
    throw new Refused(`@${role.name} is at or above your highest role, so you can't have it ${verb}.`);
  }
}

/** Roles handed out automatically (autorole, buttons, verification) must not carry dangerous permissions. */
function assertSafeSelfAssignable(ctx: Ctx, role: Role, feature: string): void {
  if (role.id === ctx.guild.id) throw new Refused(`@everyone can't be used for ${feature}.`);
  if (role.managed) throw new Refused(`@${role.name} is managed by an integration and can't be used for ${feature}.`);
  if (isDangerous(role.permissions.bitfield)) {
    throw new Refused(`@${role.name} has moderator/admin permissions, so I won't hand it out via ${feature}.`);
  }
  if (role.position >= ctx.me.roles.highest.position) throw new Refused(`@${role.name} is above my role, so I can't assign it.`);
}

type OwEntry = { id: string; type: OverwriteType; allow: bigint; deny: bigint };

function existingOverwrites(channel?: GuildChannel | null): Map<string, OwEntry> {
  const map = new Map<string, OwEntry>();
  channel?.permissionOverwrites.cache.forEach((o) => map.set(o.id, { id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }));
  return map;
}

interface PermSpec {
  private?: boolean;
  read_only?: boolean;
  allowed_roles?: string[];
  permissions?: { target: string; allow?: string[]; deny?: string[] }[];
}

const hasPermSpec = (s: PermSpec) => s.private !== undefined || s.read_only !== undefined || !!s.allowed_roles?.length || !!s.permissions?.length;

function applyPermSpec(ctx: Ctx, map: Map<string, OwEntry>, spec: PermSpec, where: string): void {
  const entry = (id: string, type: OverwriteType) => {
    let e = map.get(id);
    if (!e) map.set(id, (e = { id, type, allow: 0n, deny: 0n }));
    return e;
  };
  const allow = (e: OwEntry, bits: bigint) => {
    e.allow |= bits;
    e.deny &= ~bits;
  };
  const deny = (e: OwEntry, bits: bigint) => {
    e.deny |= bits;
    e.allow &= ~bits;
  };
  const everyone = entry(ctx.guild.id, OverwriteType.Role);
  const allowedRoles = (spec.allowed_roles ?? [])
    .map((r) => {
      const role = resolveRole(ctx.guild, ctx.keys, r);
      if (!role) ctx.result.warnings.push(`${where}: role "${r}" not found for allowed_roles.`);
      return role;
    })
    .filter((r): r is Role => !!r);

  const view = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect;
  const talk =
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.SendMessagesInThreads |
    PermissionFlagsBits.CreatePublicThreads |
    PermissionFlagsBits.CreatePrivateThreads;

  if (spec.private === true) {
    deny(everyone, view);
    for (const r of allowedRoles) allow(entry(r.id, OverwriteType.Role), view);
  } else if (spec.private === false) {
    everyone.deny &= ~view;
  }
  if (spec.read_only === true) {
    deny(everyone, talk);
    for (const r of allowedRoles) allow(entry(r.id, OverwriteType.Role), PermissionFlagsBits.SendMessages | PermissionFlagsBits.SendMessagesInThreads);
  } else if (spec.read_only === false) {
    everyone.deny &= ~talk;
  }
  if (!spec.private && !spec.read_only) for (const r of allowedRoles) allow(entry(r.id, OverwriteType.Role), view);

  for (const p of spec.permissions ?? []) {
    let id: string | undefined;
    let type = OverwriteType.Role;
    const role = resolveRole(ctx.guild, ctx.keys, p.target);
    if (role) id = role.id;
    else {
      const member = /^\d{17,20}$/.test(p.target.replace(/[<@!>]/g, '')) ? p.target.replace(/[<@!>]/g, '') : undefined;
      if (member) {
        id = member;
        type = OverwriteType.Member;
      }
    }
    if (!id) {
      ctx.result.warnings.push(`${where}: permission target "${p.target}" not found.`);
      continue;
    }
    const a = resolvePermissions(p.allow);
    const d = resolvePermissions(p.deny);
    warnUnknownPerms(ctx, [...a.unknown, ...d.unknown], where);
    const e = entry(id, type);
    allow(e, limitToBot(ctx, a.bits, where));
    deny(e, limitToBot(ctx, d.bits, where));
  }

  // Never lock the bot out of a channel it just made private.
  if ((everyone.deny & PermissionFlagsBits.ViewChannel) !== 0n && !ctx.me.permissions.has('Administrator')) {
    allow(
      entry(ctx.me.id, OverwriteType.Member),
      PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.SendMessages |
        PermissionFlagsBits.ReadMessageHistory |
        PermissionFlagsBits.EmbedLinks |
        PermissionFlagsBits.ManageChannels |
        PermissionFlagsBits.Connect,
    );
  }
}

const toOverwriteList = (map: Map<string, OwEntry>) =>
  [...map.values()].filter((o) => o.allow || o.deny).map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));

function channelTypeOf(raw?: string): ChannelType {
  switch (raw) {
    case 'voice':
    case 'vc':
    case 'voicechannel':
      return ChannelType.GuildVoice;
    case 'announcement':
    case 'announcements':
    case 'news':
      return ChannelType.GuildAnnouncement;
    case 'forum':
    case 'media':
      return ChannelType.GuildForum;
    case 'stage':
    case 'stagechannel':
      return ChannelType.GuildStageVoice;
    default:
      return ChannelType.GuildText;
  }
}

function buildEmbed(spec: { title?: string; description?: string; color?: string | number; fields?: { name: string; value: string; inline?: boolean }[]; footer?: string; image_url?: string; thumbnail_url?: string }) {
  const embed = new EmbedBuilder().setColor(resolveColor(spec.color) ?? BRAND_COLOR);
  if (spec.title) embed.setTitle(truncate(spec.title, 256)!);
  if (spec.description) embed.setDescription(truncate(spec.description, 4096)!);
  if (spec.fields?.length) {
    embed.addFields(
      spec.fields.slice(0, 25).map((f) => ({ name: truncate(f.name, 256) || '​', value: truncate(f.value, 1024) || '​', inline: !!f.inline })),
    );
  }
  if (spec.footer) embed.setFooter({ text: truncate(spec.footer, 2048)! });
  if (spec.image_url?.startsWith('https://')) embed.setImage(spec.image_url);
  if (spec.thumbnail_url?.startsWith('https://')) embed.setThumbnail(spec.thumbnail_url);
  return embed;
}

function track(ctx: Ctx, kind: string, id: string, name: string): void {
  ctx.result.created.push({ kind, id, name });
}

async function ensureCategory(ctx: Ctx, ref: string): Promise<CategoryChannel> {
  const existing = resolveChannel(ctx.guild, ctx.keys, ref, 'category');
  if (existing) return existing as CategoryChannel;
  const created = await ctx.guild.channels.create({ name: truncate(ref.replace(/^#/, ''), 100)!, type: ChannelType.GuildCategory });
  ctx.keys.channels.set(ref.toLowerCase(), created.id);
  track(ctx, 'category', created.id, created.name);
  ctx.result.warnings.push(`Category "${ref}" didn't exist, so I created it.`);
  return created;
}

/* ------------------------------------------------------------------------------------------------ */
/* Action handlers                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

type Handler<T extends ActionType> = (ctx: Ctx, a: ActionOf<T>) => Promise<string>;
type Handlers = { [T in ActionType]: Handler<T> };

const handlers: Handlers = {
  async create_role(ctx, a) {
    const { bits, unknown } = resolvePermissions(a.permissions);
    warnUnknownPerms(ctx, unknown, `@${a.name}`);
    const color = resolveColor(a.color);
    const role = await ctx.guild.roles.create({
      name: truncate(a.name, 100)!,
      colors: color !== undefined ? { primaryColor: color } : undefined,
      hoist: a.hoist,
      mentionable: a.mentionable,
      permissions: limitToBot(ctx, bits, `@${a.name}`),
      reason: 'GuildSmith AI build',
    });
    if (a.key) ctx.keys.roles.set(a.key.toLowerCase(), role.id);
    track(ctx, 'role', role.id, role.name);
    return `Created role **@${role.name}**`;
  },

  async create_category(ctx, a) {
    const map = new Map<string, OwEntry>();
    applyPermSpec(ctx, map, a, a.name);
    const cat = await ctx.guild.channels.create({
      name: truncate(a.name, 100)!,
      type: ChannelType.GuildCategory,
      permissionOverwrites: hasPermSpec(a) ? toOverwriteList(map) : undefined,
    });
    if (a.key) ctx.keys.channels.set(a.key.toLowerCase(), cat.id);
    track(ctx, 'category', cat.id, cat.name);
    return `Created category **${cat.name}**`;
  },

  async create_channel(ctx, a) {
    const parent = a.category ? await ensureCategory(ctx, a.category) : undefined;
    let type = channelTypeOf(a.channel_type);
    const community = ctx.guild.features.includes('COMMUNITY');
    if (!community && type === ChannelType.GuildAnnouncement) {
      type = ChannelType.GuildText;
      ctx.result.warnings.push(`#${a.name}: announcement channels need Community mode, made a text channel instead.`);
    }
    if (!community && type === ChannelType.GuildStageVoice) {
      type = ChannelType.GuildVoice;
      ctx.result.warnings.push(`${a.name}: stage channels need Community mode, made a voice channel instead.`);
    }
    let overwrites: ReturnType<typeof toOverwriteList> | undefined;
    if (hasPermSpec(a)) {
      const map = existingOverwrites(parent);
      applyPermSpec(ctx, map, a, a.name);
      overwrites = toOverwriteList(map);
    }
    const isVoice = type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
    const options = {
      name: truncate(a.name, 100)!,
      type,
      parent: parent?.id,
      topic: isVoice ? undefined : truncate(a.topic, 1024),
      nsfw: a.nsfw,
      rateLimitPerUser: a.slowmode !== undefined && !isVoice ? Math.max(0, Math.min(21600, Math.round(a.slowmode))) : undefined,
      userLimit: isVoice && a.user_limit !== undefined ? Math.max(0, Math.min(99, Math.round(a.user_limit))) : undefined,
      permissionOverwrites: overwrites,
      availableTags: type === ChannelType.GuildForum && a.tags?.length ? a.tags.slice(0, 20).map((name) => ({ name: truncate(name, 20)! })) : undefined,
    };
    let channel: GuildBasedChannel;
    try {
      channel = await ctx.guild.channels.create(options as any);
    } catch (err) {
      if (type !== ChannelType.GuildForum) throw err;
      ctx.result.warnings.push(`#${a.name}: forum channel failed (${explainError(err)}), made a text channel instead.`);
      channel = await ctx.guild.channels.create({ ...options, type: ChannelType.GuildText, availableTags: undefined } as any);
    }
    if (a.key) ctx.keys.channels.set(a.key.toLowerCase(), channel.id);
    track(ctx, 'channel', channel.id, channel.name);
    return `Created ${isVoice ? '🔊' : '#'}**${channel.name}**${parent ? ` in ${parent.name}` : ''}`;
  },

  async send_message(ctx, a) {
    if (!a.content && !a.embed) throw new Refused('Message has no content.');
    const channel = needChannel(ctx, a.channel, 'notCategory');
    const payload = {
      content: truncate(a.content, 2000),
      embeds: a.embed ? [buildEmbed(a.embed)] : [],
      allowedMentions: { parse: [] as never[] },
    };
    if (channel.type === ChannelType.GuildForum) {
      const thread = await channel.threads.create({ name: truncate(a.embed?.title ?? a.content ?? 'Welcome', 100)!, message: payload });
      return `Posted **${thread.name}** in forum #${channel.name}`;
    }
    if (!channel.isTextBased() || !('send' in channel)) throw new Refused(`#${channel.name} can't receive messages.`);
    const msg = await channel.send(payload);
    if (a.pin) await msg.pin().catch((err) => ctx.result.warnings.push(`Couldn't pin in #${channel.name}: ${explainError(err)}`));
    return `Posted a message in #${channel.name}`;
  },

  async create_automod_rule(ctx, a) {
    const triggers: Record<string, AutoModerationRuleTriggerType> = {
      keyword: AutoModerationRuleTriggerType.Keyword,
      keywords: AutoModerationRuleTriggerType.Keyword,
      keywordpreset: AutoModerationRuleTriggerType.KeywordPreset,
      preset: AutoModerationRuleTriggerType.KeywordPreset,
      spam: AutoModerationRuleTriggerType.Spam,
      mentionspam: AutoModerationRuleTriggerType.MentionSpam,
      mention: AutoModerationRuleTriggerType.MentionSpam,
    };
    const triggerType = triggers[a.trigger];
    if (!triggerType) throw new Refused(`Unknown AutoMod trigger "${a.trigger}" (use keyword, keyword_preset, spam or mention_spam).`);

    const presetMap: Record<string, AutoModerationRuleKeywordPresetType> = {
      profanity: AutoModerationRuleKeywordPresetType.Profanity,
      sexualcontent: AutoModerationRuleKeywordPresetType.SexualContent,
      sexual: AutoModerationRuleKeywordPresetType.SexualContent,
      slurs: AutoModerationRuleKeywordPresetType.Slurs,
    };
    const presets = (a.presets ?? ['profanity', 'sexual_content', 'slurs'])
      .map((p) => presetMap[p.toLowerCase().replace(/[^a-z]/g, '')])
      .filter((p): p is AutoModerationRuleKeywordPresetType => p !== undefined);

    const timeoutAllowed = triggerType === AutoModerationRuleTriggerType.Keyword || triggerType === AutoModerationRuleTriggerType.MentionSpam;
    type ModAction = { type: AutoModerationActionType; metadata?: Record<string, unknown> };
    const actions = (a.actions?.length ? a.actions : [{ type: 'block' as string, channel: undefined, duration_seconds: undefined, message: undefined }]).flatMap((act): ModAction[] => {
      if (act.type.startsWith('block') || act.type === 'delete') {
        return [{ type: AutoModerationActionType.BlockMessage, metadata: act.message ? { customMessage: truncate(act.message, 150) } : undefined }];
      }
      if (act.type.startsWith('alert') || act.type === 'log' || act.type === 'notify') {
        const ch = resolveChannel(ctx.guild, ctx.keys, act.channel, 'notCategory');
        if (!ch) {
          ctx.result.warnings.push(`AutoMod "${a.name}": alert channel "${act.channel}" not found, alert skipped.`);
          return [];
        }
        return [{ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: ch.id } }];
      }
      if (act.type.startsWith('timeout') || act.type === 'mute') {
        if (!timeoutAllowed) {
          ctx.result.warnings.push(`AutoMod "${a.name}": Discord only allows timeouts on keyword / mention rules, skipped.`);
          return [];
        }
        return [{ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: Math.max(60, Math.min(2419200, Math.round(act.duration_seconds ?? 300))) } }];
      }
      ctx.result.warnings.push(`AutoMod "${a.name}": unknown action "${act.type}" skipped.`);
      return [];
    });
    if (!actions.length) actions.push({ type: AutoModerationActionType.BlockMessage, metadata: undefined });

    const triggerMetadata: Record<string, unknown> = {};
    if (triggerType === AutoModerationRuleTriggerType.Keyword) {
      const keywords = (a.keywords ?? []).map((k) => truncate(k, 60)!).slice(0, 1000);
      const regex = (a.regex ?? []).slice(0, 10);
      if (!keywords.length && !regex.length) throw new Refused(`AutoMod "${a.name}" needs keywords.`);
      triggerMetadata.keywordFilter = keywords;
      triggerMetadata.regexPatterns = regex;
      if (a.allow_list?.length) triggerMetadata.allowList = a.allow_list.slice(0, 100);
    } else if (triggerType === AutoModerationRuleTriggerType.KeywordPreset) {
      triggerMetadata.presets = presets.length ? presets : [AutoModerationRuleKeywordPresetType.Profanity];
      if (a.allow_list?.length) triggerMetadata.allowList = a.allow_list.slice(0, 1000);
    } else if (triggerType === AutoModerationRuleTriggerType.MentionSpam) {
      triggerMetadata.mentionTotalLimit = Math.max(1, Math.min(50, Math.round(a.mention_limit ?? 5)));
      triggerMetadata.mentionRaidProtectionEnabled = a.raid_protection ?? true;
    }

    const exemptRoles = (a.exempt_roles ?? []).map((r) => resolveRole(ctx.guild, ctx.keys, r)?.id).filter((x): x is string => !!x);
    const exemptChannels = (a.exempt_channels ?? []).map((c) => resolveChannel(ctx.guild, ctx.keys, c)?.id).filter((x): x is string => !!x);

    const rule = await ctx.guild.autoModerationRules.create({
      name: truncate(a.name, 100)!,
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType,
      triggerMetadata,
      actions: actions as any,
      enabled: a.enabled ?? true,
      exemptRoles,
      exemptChannels,
      reason: 'GuildSmith AI build',
    });
    track(ctx, 'automod', rule.id, rule.name);
    return `Created AutoMod rule **${rule.name}**`;
  },

  async setup_welcome(ctx, a) {
    const ch = needTextChannel(ctx, a.channel);
    updateGuild(ctx.guild.id, (g) => {
      g.welcome = {
        channelId: ch.id,
        message: truncate(a.message, 1800)!,
        embed: a.embed ?? true,
        title: truncate(a.title, 200),
        color: resolveColor(a.color),
        imageUrl: a.image_url?.startsWith('https://') ? a.image_url : undefined,
        dmMessage: truncate(a.dm_message, 1800),
      };
    });
    ctx.result.changed.push(`welcome messages → #${ch.name}`);
    return `Welcome messages will post in #${ch.name}`;
  },

  async setup_goodbye(ctx, a) {
    const ch = needTextChannel(ctx, a.channel);
    updateGuild(ctx.guild.id, (g) => {
      g.goodbye = { channelId: ch.id, message: truncate(a.message, 1800)!, embed: a.embed ?? true };
    });
    ctx.result.changed.push(`goodbye messages → #${ch.name}`);
    return `Goodbye messages will post in #${ch.name}`;
  },

  async setup_autorole(ctx, a) {
    const pick = (refs: string[] | undefined) =>
      (refs ?? []).map((r) => {
        const role = needRole(ctx, r, 'auto role');
        assertSafeSelfAssignable(ctx, role, 'auto roles');
        return role;
      });
    const humans = pick(a.roles);
    const bots = pick(a.bot_roles);
    if (!humans.length && !bots.length) throw new Refused('No roles given for auto role.');
    updateGuild(ctx.guild.id, (g) => {
      g.autorole = { roleIds: humans.map((r) => r.id), botRoleIds: bots.map((r) => r.id) };
    });
    ctx.result.changed.push('auto roles');
    const parts = [humans.length ? `members get ${humans.map((r) => `@${r.name}`).join(', ')}` : '', bots.length ? `bots get ${bots.map((r) => `@${r.name}`).join(', ')}` : ''];
    return `Auto role on join: ${parts.filter(Boolean).join('; ')}`;
  },

  async create_role_menu(ctx, a) {
    const ch = needTextChannel(ctx, a.channel);
    const entries = a.roles.slice(0, 25).map((r) => {
      const role = needRole(ctx, r.role, 'role menu');
      assertSafeSelfAssignable(ctx, role, 'role menus');
      return { role, label: truncate(r.label || role.name, 80)!, emoji: r.emoji, description: truncate(r.description, 100) };
    });
    if (!entries.length) throw new Refused('Role menu has no roles.');
    const embed = buildEmbed({
      title: a.title,
      description: [a.description, '', ...entries.map((e) => `${e.emoji ? `${e.emoji} ` : ''}**${e.label}**${e.description ? ` — ${e.description}` : ''}`)]
        .filter((x) => x !== undefined)
        .join('\n'),
    });

    const build = (withEmoji: boolean) => {
      if (a.style === 'select' || entries.length > 10) {
        const menu = new StringSelectMenuBuilder()
          .setCustomId('gs:rrsel')
          .setPlaceholder('Pick your roles')
          .setMinValues(0)
          .setMaxValues(entries.length)
          .addOptions(
            entries.map((e) => ({
              label: e.label,
              value: e.role.id,
              description: e.description,
              emoji: withEmoji && e.emoji ? e.emoji : undefined,
            })),
          );
        return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
      }
      const rows: ActionRowBuilder<ButtonBuilder>[] = [];
      entries.forEach((e, i) => {
        if (i % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>());
        const button = new ButtonBuilder().setCustomId(`gs:rr:${e.role.id}`).setLabel(e.label).setStyle(ButtonStyle.Secondary);
        if (withEmoji && e.emoji) button.setEmoji(e.emoji);
        rows[rows.length - 1].addComponents(button);
      });
      return rows;
    };
    try {
      await ch.send({ embeds: [embed], components: build(true), allowedMentions: { parse: [] } });
    } catch (err) {
      if (!(err instanceof DiscordAPIError) || err.code !== 50035) throw err;
      await ch.send({ embeds: [embed], components: build(false), allowedMentions: { parse: [] } });
      ctx.result.warnings.push('Role menu: some emojis were invalid, posted without emojis.');
    }
    return `Posted a role menu with ${entries.length} role(s) in #${ch.name}`;
  },

  async create_verification(ctx, a) {
    const ch = needTextChannel(ctx, a.channel);
    const role = needRole(ctx, a.role, 'verification');
    assertSafeSelfAssignable(ctx, role, 'verification');
    const embed = buildEmbed({
      title: a.title ?? '✅ Verification',
      description: a.description ?? `Click the button below to verify and unlock the rest of **${ctx.guild.name}**.`,
    });
    const button = new ButtonBuilder()
      .setCustomId(`gs:verify:${role.id}`)
      .setLabel(truncate(a.button_label, 80) ?? 'Verify')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅');
    await ch.send({ embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] });
    return `Posted a verification button in #${ch.name} (gives @${role.name})`;
  },

  async create_ticket_panel(ctx, a) {
    const ch = needTextChannel(ctx, a.channel);
    const staff = (a.staff_roles ?? []).map((r) => needRole(ctx, r, 'ticket staff'));
    let category: CategoryChannel | undefined;
    if (a.category) category = await ensureCategory(ctx, a.category);
    else {
      const map = new Map<string, OwEntry>();
      applyPermSpec(ctx, map, { private: true, allowed_roles: staff.map((r) => r.id) }, 'Tickets');
      category = await ctx.guild.channels.create({ name: '🎫 Tickets', type: ChannelType.GuildCategory, permissionOverwrites: toOverwriteList(map) });
      track(ctx, 'category', category.id, category.name);
    }
    updateGuild(ctx.guild.id, (g) => {
      g.tickets = { categoryId: category!.id, staffRoleIds: staff.map((r) => r.id), counter: g.tickets?.counter ?? 0 };
    });
    const embed = buildEmbed({
      title: a.title ?? '🎫 Support',
      description: a.description ?? 'Need help? Click the button below to open a private ticket with the staff team.',
    });
    const button = new ButtonBuilder()
      .setCustomId('gs:ticket:open')
      .setLabel(truncate(a.button_label, 80) ?? 'Open a ticket')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎫');
    await ch.send({ embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] });
    ctx.result.changed.push('ticket system');
    return `Posted a ticket panel in #${ch.name}`;
  },

  async recommend_bots(ctx, a) {
    let added = 0;
    for (const bot of a.bots.slice(0, 25)) {
      const known = findCatalogBot(bot.name) ?? BOT_CATALOG.find((b) => b.clientId === bot.client_id);
      const clientId = known?.clientId ?? bot.client_id;
      if (!clientId || !/^\d{17,20}$/.test(clientId)) {
        ctx.result.warnings.push(`${bot.name}: I don't know its client id. Add it manually from its website or top.gg.`);
        continue;
      }
      const real = await lookupApplication(clientId);
      ctx.result.links.push({
        label: truncate(real?.name ?? known?.name ?? bot.name, 80)!,
        url: botInviteUrl(clientId, ctx.guild.id, known?.permissions ?? '8'),
        note: bot.reason ?? known?.description,
      });
      added++;
    }
    return `Prepared ${added} one-click bot invite link(s)`;
  },

  async set_bot_profile(ctx, a) {
    const edit: Record<string, unknown> = {};
    if (a.nickname !== undefined) edit.nick = truncate(a.nickname, 32);
    if (a.bio !== undefined) edit.bio = truncate(a.bio, 190);
    await ctx.guild.members.editMe(edit);
    return `Updated my server profile`;
  },

  async edit_channel(ctx, a) {
    const channel = needChannel(ctx, a.channel) as GuildChannel;
    const before = channel.name;
    if (hasPermSpec(a)) {
      const map = existingOverwrites(channel);
      applyPermSpec(ctx, map, a, channel.name);
      await channel.permissionOverwrites.set(toOverwriteList(map));
    }
    const edit: Record<string, unknown> = {};
    if (a.name) edit.name = truncate(a.name, 100);
    if (a.topic !== undefined && 'topic' in channel) edit.topic = truncate(a.topic, 1024);
    if (a.nsfw !== undefined && 'nsfw' in channel) edit.nsfw = a.nsfw;
    if (a.slowmode !== undefined && 'rateLimitPerUser' in channel) edit.rateLimitPerUser = Math.max(0, Math.min(21600, Math.round(a.slowmode)));
    if (a.user_limit !== undefined && 'userLimit' in channel) edit.userLimit = Math.max(0, Math.min(99, Math.round(a.user_limit)));
    if (a.position !== undefined) edit.position = Math.max(0, Math.round(a.position));
    if (a.category !== undefined && channel.type !== ChannelType.GuildCategory) {
      edit.parent = a.category === null || a.category === '' || a.category.toLowerCase() === 'none' ? null : (await ensureCategory(ctx, a.category)).id;
      edit.lockPermissions = !!a.sync_permissions;
    }
    if (Object.keys(edit).length) await channel.edit(edit);
    if (a.sync_permissions && channel.parent && edit.parent === undefined) await channel.lockPermissions();
    ctx.result.changed.push(`#${before}`);
    return `Updated **${before}**${a.name && a.name !== before ? ` → **${channel.name}**` : ''}`;
  },

  async delete_channel(ctx, a) {
    const channel = needChannel(ctx, a.channel);
    let extra = '';
    if (channel.type === ChannelType.GuildCategory && a.delete_children) {
      const children = [...(channel as CategoryChannel).children.cache.values()];
      for (const child of children) await child.delete('GuildSmith AI build');
      extra = ` and its ${children.length} channel(s)`;
    }
    await channel.delete('GuildSmith AI build');
    ctx.result.changed.push(`deleted ${channel.name}`);
    return `Deleted **${channel.name}**${extra}`;
  },

  async edit_role(ctx, a) {
    const role = needRole(ctx, a.role, 'edit');
    assertCanManageRole(ctx, role, 'edited');
    const edit: Record<string, unknown> = {};
    if (a.name && role.id !== ctx.guild.id) edit.name = truncate(a.name, 100);
    const color = resolveColor(a.color);
    if (color !== undefined) edit.colors = { primaryColor: color };
    if (a.hoist !== undefined) edit.hoist = a.hoist;
    if (a.mentionable !== undefined) edit.mentionable = a.mentionable;
    if (a.permissions || a.add_permissions || a.remove_permissions) {
      const set = resolvePermissions(a.permissions);
      const add = resolvePermissions(a.add_permissions);
      const remove = resolvePermissions(a.remove_permissions);
      warnUnknownPerms(ctx, [...set.unknown, ...add.unknown, ...remove.unknown], `@${role.name}`);
      let bits = a.permissions ? set.bits : role.permissions.bitfield;
      bits = (bits | limitToBot(ctx, add.bits, `@${role.name}`)) & ~remove.bits;
      edit.permissions = a.permissions ? limitToBot(ctx, bits, `@${role.name}`) : bits;
    }
    const before = role.name;
    if (Object.keys(edit).length) await role.edit({ ...edit, reason: 'GuildSmith AI build' });
    if (a.position !== undefined) await role.setPosition(Math.max(1, Math.min(ctx.me.roles.highest.position - 1, Math.round(a.position))));
    ctx.result.changed.push(`@${before}`);
    return `Updated role **@${before}**${edit.name && edit.name !== before ? ` → **@${role.name}**` : ''}`;
  },

  async delete_role(ctx, a) {
    const role = needRole(ctx, a.role, 'delete');
    if (role.id === ctx.guild.id) throw new Refused("@everyone can't be deleted.");
    assertCanManageRole(ctx, role, 'deleted');
    await role.delete('GuildSmith AI build');
    ctx.result.changed.push(`deleted @${role.name}`);
    return `Deleted role **@${role.name}**`;
  },

  async set_permissions(ctx, a) {
    const channel = needChannel(ctx, a.channel) as GuildChannel;
    const role = resolveRole(ctx.guild, ctx.keys, a.target);
    const memberId = role ? undefined : /^\d{17,20}$/.test(a.target.replace(/[<@!>]/g, '')) ? a.target.replace(/[<@!>]/g, '') : undefined;
    const target = role?.id ?? memberId;
    if (!target) throw new Refused(`Permission target "${a.target}" not found.`);
    const label = role ? (role.id === ctx.guild.id ? '@everyone' : `@${role.name}`) : `<@${memberId}>`;
    if (a.clear) {
      await channel.permissionOverwrites.delete(target);
      ctx.result.changed.push(`#${channel.name} perms`);
      return `Cleared ${label}'s overrides on **${channel.name}**`;
    }
    const allow = resolvePermissions(a.allow);
    const deny = resolvePermissions(a.deny);
    warnUnknownPerms(ctx, [...allow.unknown, ...deny.unknown], channel.name);
    const flags: Partial<Record<PermissionsString, boolean>> = {};
    for (const n of new PermissionsBitField(limitToBot(ctx, allow.bits, channel.name)).toArray()) flags[n] = true;
    for (const n of new PermissionsBitField(limitToBot(ctx, deny.bits, channel.name)).toArray()) flags[n] = false;
    if (!Object.keys(flags).length) throw new Refused('No valid permissions to change.');
    await channel.permissionOverwrites.edit(target, flags, { type: role ? OverwriteType.Role : OverwriteType.Member });
    ctx.result.changed.push(`#${channel.name} perms`);
    return `Updated ${label}'s permissions on **${channel.name}**`;
  },

  async assign_role(ctx, a) {
    const role = needRole(ctx, a.role, 'assign');
    if (role.id === ctx.guild.id) throw new Refused("Everyone already has @everyone.");
    assertCanManageRole(ctx, role, a.remove ? 'removed' : 'assigned');
    const members = new Map<string, GuildMember>();
    for (const ref of a.users ?? []) {
      const idMatch = ref.replace(/[<@!>]/g, '');
      const member = /^\d{17,20}$/.test(idMatch)
        ? await ctx.guild.members.fetch(idMatch).catch(() => undefined)
        : (await ctx.guild.members.fetch({ query: ref.replace(/^@/, ''), limit: 1 }).catch(() => undefined))?.first();
      if (member) members.set(member.id, member);
      else ctx.result.warnings.push(`Member "${ref}" not found.`);
    }
    if (a.everyone) {
      if (isDangerous(role.permissions.bitfield)) throw new Refused(`@${role.name} has moderator/admin permissions, I won't mass-assign it.`);
      const all = await ctx.guild.members.fetch();
      const group = a.everyone.toLowerCase();
      for (const m of all.values()) {
        if (group.startsWith('bot') ? m.user.bot : group.startsWith('human') ? !m.user.bot : true) members.set(m.id, m);
      }
    }
    const targets = [...members.values()].filter((m) => (a.remove ? m.roles.cache.has(role.id) : !m.roles.cache.has(role.id))).slice(0, 2000);
    let done = 0;
    for (const m of targets) {
      try {
        if (a.remove) await m.roles.remove(role, 'GuildSmith AI build');
        else await m.roles.add(role, 'GuildSmith AI build');
        done++;
      } catch (err) {
        ctx.result.warnings.push(`${m.user.tag}: ${explainError(err)}`);
      }
    }
    ctx.result.changed.push(`@${role.name} members`);
    return `${a.remove ? 'Removed' : 'Gave'} **@${role.name}** ${a.remove ? 'from' : 'to'} ${done} member(s)`;
  },

  async edit_server(ctx, a) {
    const edit: Record<string, unknown> = {};
    const notes: string[] = [];
    if (a.name) edit.name = truncate(a.name, 100);
    if (a.description !== undefined) edit.description = truncate(a.description, 120);
    if (a.verification_level) {
      const map: Record<string, GuildVerificationLevel> = {
        none: GuildVerificationLevel.None,
        low: GuildVerificationLevel.Low,
        medium: GuildVerificationLevel.Medium,
        high: GuildVerificationLevel.High,
        veryhigh: GuildVerificationLevel.VeryHigh,
        highest: GuildVerificationLevel.VeryHigh,
      };
      const level = map[a.verification_level.toLowerCase().replace(/[^a-z]/g, '')] ?? (Number(a.verification_level) as GuildVerificationLevel);
      if (level in GuildVerificationLevel) edit.verificationLevel = level;
    }
    if (a.explicit_content_filter) {
      const v = a.explicit_content_filter.toLowerCase();
      edit.explicitContentFilter = v.includes('all')
        ? GuildExplicitContentFilter.AllMembers
        : v.includes('without') || v.includes('no_role') || v.includes('norole')
          ? GuildExplicitContentFilter.MembersWithoutRoles
          : GuildExplicitContentFilter.Disabled;
    }
    if (a.default_notifications) {
      edit.defaultMessageNotifications = a.default_notifications.toLowerCase().includes('mention')
        ? GuildDefaultMessageNotifications.OnlyMentions
        : GuildDefaultMessageNotifications.AllMessages;
    }
    if (a.system_channel !== undefined) edit.systemChannel = a.system_channel ? needChannel(ctx, a.system_channel, 'notCategory').id : null;
    if (a.rules_channel) edit.rulesChannel = needChannel(ctx, a.rules_channel, 'notCategory').id;
    if (a.updates_channel) edit.publicUpdatesChannel = needChannel(ctx, a.updates_channel, 'notCategory').id;
    if (a.afk_channel !== undefined) edit.afkChannel = a.afk_channel ? needChannel(ctx, a.afk_channel, 'notCategory').id : null;
    if (a.afk_timeout !== undefined) {
      const allowed = [60, 300, 900, 1800, 3600];
      edit.afkTimeout = allowed.reduce((best, v) => (Math.abs(v - a.afk_timeout!) < Math.abs(best - a.afk_timeout!) ? v : best), 300);
    }
    if (a.preferred_locale) {
      const locale = Object.values(Locale).find((l) => l.toLowerCase() === a.preferred_locale!.toLowerCase());
      if (locale) edit.preferredLocale = locale;
      else notes.push(`unknown locale ${a.preferred_locale}`);
    }
    if (a.icon_url) {
      edit.icon = await fetchImage(a.icon_url);
    } else if (a.icon_prompt) {
      const falKey = falKeyFor(ctx.guild.id);
      if (falKey) edit.icon = await generateImage(falKey, `Discord server icon, ${a.icon_prompt}, bold simple centered logo, vibrant, no text`);
      else ctx.result.warnings.push('AI icons need a fal.ai key (pick fal in /provider or set FAL_KEY in .env). Icon skipped.');
    }
    if (a.banner_url) {
      if (ctx.guild.features.includes('BANNER')) edit.banner = await fetchImage(a.banner_url);
      else ctx.result.warnings.push('Server banners need boost level 2. Banner skipped.');
    }
    if (!Object.keys(edit).length) throw new Refused(`Nothing to change on the server${notes.length ? ` (${notes.join(', ')})` : ''}.`);
    await ctx.guild.edit({ ...edit, reason: 'GuildSmith AI build' });
    ctx.result.changed.push('server settings');
    return `Updated server settings (${Object.keys(edit).join(', ')})`;
  },

  async enable_community(ctx, a) {
    if (ctx.guild.features.includes('COMMUNITY')) return 'Community mode was already on';
    const rules = needChannel(ctx, a.rules_channel, 'notCategory');
    const updates = needChannel(ctx, a.updates_channel, 'notCategory');
    await ctx.guild.edit({
      features: [...ctx.guild.features, 'COMMUNITY'] as any,
      verificationLevel: Math.max(ctx.guild.verificationLevel, GuildVerificationLevel.Low),
      explicitContentFilter: GuildExplicitContentFilter.AllMembers,
      defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
      rulesChannel: rules.id,
      publicUpdatesChannel: updates.id,
      reason: 'GuildSmith AI build',
    });
    ctx.result.changed.push('community mode');
    return `Enabled **Community mode** (rules: #${rules.name}, updates: #${updates.name})`;
  },

  async setup_onboarding(ctx, a) {
    await ctx.guild.fetch();
    if (!ctx.guild.features.includes('COMMUNITY')) throw new Refused('Onboarding needs Community mode. Enable it first (add an enable_community step).');
    const everyoneCanSend = (c: GuildBasedChannel) =>
      c.type === ChannelType.GuildText && c.permissionsFor(ctx.guild.roles.everyone).has(['ViewChannel', 'SendMessages']);

    const defaults = new Set<string>();
    for (const ref of a.default_channels ?? []) {
      const ch = resolveChannel(ctx.guild, ctx.keys, ref, 'notCategory');
      if (ch) defaults.add(ch.id);
      else ctx.result.warnings.push(`Onboarding: default channel "${ref}" not found.`);
    }
    // Discord requires 7+ default channels, 5+ of which @everyone can talk in. Top up with public channels.
    const publicChannels = [...ctx.guild.channels.cache.values()].filter((c) => everyoneCanSend(c));
    const countSendable = () => [...defaults].filter((id) => everyoneCanSend(ctx.guild.channels.cache.get(id)!)).length;
    for (const c of publicChannels) {
      if (defaults.size >= 7 && countSendable() >= 5) break;
      if (!defaults.has(c.id)) defaults.add(c.id);
    }
    if (countSendable() < 5) ctx.result.warnings.push('Onboarding: Discord needs at least 5 default channels everyone can chat in. It may refuse to enable.');

    const prompts = (a.prompts ?? []).slice(0, 15).map((p) => ({
      title: truncate(p.title, 100)!,
      singleSelect: p.single_select ?? false,
      required: p.required ?? false,
      inOnboarding: p.in_onboarding ?? true,
      type: p.type?.toLowerCase().includes('drop') ? GuildOnboardingPromptType.Dropdown : GuildOnboardingPromptType.MultipleChoice,
      options: p.options.slice(0, 50).flatMap((o) => {
        const roles = (o.roles ?? []).map((r) => resolveRole(ctx.guild, ctx.keys, r)).filter((r): r is Role => !!r && !isDangerous(r.permissions.bitfield) && r.id !== ctx.guild.id);
        const channels = (o.channels ?? []).map((c) => resolveChannel(ctx.guild, ctx.keys, c)?.id).filter((x): x is string => !!x);
        if (!roles.length && !channels.length) {
          ctx.result.warnings.push(`Onboarding option "${o.title}" has no valid roles/channels, skipped.`);
          return [];
        }
        const emoji = o.emoji && !/^[a-z0-9_:]+$/i.test(o.emoji) ? o.emoji : undefined;
        return [{ title: truncate(o.title, 50)!, description: truncate(o.description, 100) ?? null, emoji, roles: roles.map((r) => r.id), channels }];
      }),
    })).filter((p) => p.options.length > 0);

    await ctx.guild.editOnboarding({
      enabled: a.enabled ?? true,
      mode: a.mode?.toLowerCase().includes('adv') ? GuildOnboardingMode.OnboardingAdvanced : GuildOnboardingMode.OnboardingDefault,
      defaultChannels: [...defaults],
      prompts,
      reason: 'GuildSmith AI build',
    });
    ctx.result.changed.push('onboarding');
    return `Set up **Onboarding** (${prompts.length} question(s), ${defaults.size} default channels)`;
  },

  async edit_automod_rule(ctx, a) {
    const rules = await ctx.guild.autoModerationRules.fetch();
    const rule = rules.get(a.rule) ?? rules.find((r) => r.name.toLowerCase() === a.rule.toLowerCase());
    if (!rule) throw new Refused(`AutoMod rule "${a.rule}" not found.`);
    const edit: Record<string, unknown> = {};
    if (a.enabled !== undefined) edit.enabled = a.enabled;
    if (a.keywords || a.add_keywords) {
      const base = a.keywords ?? rule.triggerMetadata.keywordFilter;
      edit.triggerMetadata = { ...rule.triggerMetadata, keywordFilter: [...new Set([...base, ...(a.add_keywords ?? [])])].slice(0, 1000) };
    }
    if (a.exempt_roles) edit.exemptRoles = a.exempt_roles.map((r) => resolveRole(ctx.guild, ctx.keys, r)?.id).filter(Boolean);
    if (a.exempt_channels) edit.exemptChannels = a.exempt_channels.map((c) => resolveChannel(ctx.guild, ctx.keys, c)?.id).filter(Boolean);
    await rule.edit(edit);
    ctx.result.changed.push(`automod ${rule.name}`);
    return `Updated AutoMod rule **${rule.name}**`;
  },

  async delete_automod_rule(ctx, a) {
    const rules = await ctx.guild.autoModerationRules.fetch();
    const rule = rules.get(a.rule) ?? rules.find((r) => r.name.toLowerCase() === a.rule.toLowerCase());
    if (!rule) throw new Refused(`AutoMod rule "${a.rule}" not found.`);
    await rule.delete('GuildSmith AI build');
    ctx.result.changed.push(`deleted automod ${rule.name}`);
    return `Deleted AutoMod rule **${rule.name}**`;
  },

  async disable_feature(ctx, a) {
    const feature = (['welcome', 'goodbye', 'autorole', 'tickets'] as const).find((f) => a.feature.replace(/[^a-z]/g, '').startsWith(f.slice(0, 5)));
    if (!feature) throw new Refused(`Unknown feature "${a.feature}" (welcome, goodbye, autorole, tickets).`);
    updateGuild(ctx.guild.id, (g) => {
      delete g[feature];
    });
    ctx.result.changed.push(`disabled ${feature}`);
    return `Turned off **${feature}**`;
  },
};

/* ------------------------------------------------------------------------------------------------ */
/* Runner                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export interface ExecOptions {
  guild: Guild;
  actor: GuildMember;
  actions: Action[];
  allowDestructive: boolean;
  onProgress?: (done: number, total: number, last: ResultLine) => void;
}

export async function executePlan(opts: ExecOptions): Promise<ExecResult> {
  const me = opts.guild.members.me ?? (await opts.guild.members.fetchMe());
  const ctx: Ctx = {
    guild: opts.guild,
    me,
    actor: opts.actor,
    keys: newKeys(),
    result: { lines: [], created: [], changed: [], links: [], warnings: [] },
  };
  const planned = plannedNames(opts.guild, opts.actions);
  const actions = opts.actions.slice(0, config.maxActionsPerPlan);
  if (opts.actions.length > actions.length) ctx.result.warnings.push(`Plan had ${opts.actions.length} steps; only the first ${actions.length} ran (MAX_ACTIONS_PER_PLAN).`);

  for (const [i, action] of actions.entries()) {
    let line: ResultLine;
    if (!opts.allowDestructive && isActionDestructive(action, planned)) {
      line = { status: 'skipped', text: `${describeAction(action)} (destructive, not approved)` };
    } else {
      try {
        const handler = handlers[action.type] as Handler<typeof action.type>;
        line = { status: 'ok', text: await handler(ctx, action as never) };
      } catch (err) {
        if (!(err instanceof Refused)) log.warn(`[exec] ${action.type} failed in ${opts.guild.id}:`, err);
        line = { status: 'failed', text: `${describeAction(action)}: ${explainError(err)}` };
      }
    }
    ctx.result.lines.push(line);
    opts.onProgress?.(i + 1, actions.length, line);
  }
  return ctx.result;
}

/** One-line human description of an action, for previews and reports. */
export function describeAction(a: Action): string {
  switch (a.type) {
    case 'create_role':
      return `➕ Create role @${a.name}${a.permissions?.length ? ` (${a.permissions.slice(0, 4).join(', ')}${a.permissions.length > 4 ? '…' : ''})` : ''}`;
    case 'create_category':
      return `📁 Create category ${a.name}${a.private ? ' (private)' : ''}`;
    case 'create_channel':
      return `${['voice', 'vc', 'stage'].includes(a.channel_type ?? '') ? '🔊' : '#️⃣'} Create ${a.channel_type ?? 'text'} channel ${a.name}${a.category ? ` in ${a.category}` : ''}${a.private ? ' (private)' : ''}${a.read_only ? ' (read-only)' : ''}`;
    case 'send_message':
      return `💬 Post a message in ${a.channel}`;
    case 'create_automod_rule':
      return `🛡️ AutoMod rule "${a.name}" (${a.trigger})`;
    case 'setup_welcome':
      return `👋 Welcome messages in ${a.channel}`;
    case 'setup_goodbye':
      return `🚪 Goodbye messages in ${a.channel}`;
    case 'setup_autorole':
      return `🎭 Auto role on join: ${[...(a.roles ?? []), ...(a.bot_roles ?? [])].join(', ')}`;
    case 'create_role_menu':
      return `🎨 Self-role menu in ${a.channel} (${a.roles.length} roles)`;
    case 'create_verification':
      return `✅ Verification button in ${a.channel} → @${a.role}`;
    case 'create_ticket_panel':
      return `🎫 Ticket panel in ${a.channel}`;
    case 'recommend_bots':
      return `🤖 Bot invites: ${a.bots.map((b) => b.name).join(', ')}`;
    case 'set_bot_profile':
      return `🪪 Update my nickname/bio`;
    case 'edit_channel':
      return `✏️ Edit channel ${a.channel}${a.name ? ` → ${a.name}` : ''}`;
    case 'delete_channel':
      return `🗑️ Delete ${a.channel}${a.delete_children ? ' (and everything inside)' : ''}`;
    case 'edit_role':
      return `✏️ Edit role @${a.role}${a.name ? ` → @${a.name}` : ''}`;
    case 'delete_role':
      return `🗑️ Delete role @${a.role}`;
    case 'set_permissions':
      return `🔐 ${a.clear ? 'Clear' : 'Change'} ${a.target}'s permissions in ${a.channel}`;
    case 'assign_role':
      return `👥 ${a.remove ? 'Remove' : 'Give'} @${a.role} ${a.everyone ? `(${a.everyone})` : `(${(a.users ?? []).length} user(s))`}`;
    case 'edit_server':
      return `⚙️ Edit server settings (${Object.keys(a).filter((k) => k !== 'type').join(', ')})`;
    case 'enable_community':
      return `🌐 Enable Community mode`;
    case 'setup_onboarding':
      return `🧭 Set up Onboarding (${a.prompts?.length ?? 0} questions)`;
    case 'edit_automod_rule':
      return `🛡️ Edit AutoMod rule ${a.rule}`;
    case 'delete_automod_rule':
      return `🗑️ Delete AutoMod rule ${a.rule}`;
    case 'disable_feature':
      return `⛔ Turn off ${a.feature}`;
  }
}
