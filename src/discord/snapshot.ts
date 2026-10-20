import {
  CategoryChannel,
  ChannelType,
  Guild,
  GuildBasedChannel,
  GuildChannel,
  GuildExplicitContentFilter,
  GuildVerificationLevel,
  PermissionOverwrites,
} from 'discord.js';
import { getGuild } from '../storage/db';
import { isDangerous, permissionNames } from './permissions';

const MAX_CHANNELS = 200;

const typeNames: Partial<Record<ChannelType, string>> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildMedia]: 'media',
  [ChannelType.GuildCategory]: 'category',
};

function overwrites(guild: Guild, channel: GuildChannel) {
  return channel.permissionOverwrites.cache.map((o: PermissionOverwrites) => {
    const target = o.id === guild.id ? '@everyone' : guild.roles.cache.get(o.id)?.name ?? `member:${o.id}`;
    const entry: Record<string, unknown> = { target };
    if (o.allow.bitfield) entry.allow = permissionNames(o.allow.bitfield);
    if (o.deny.bitfield) entry.deny = permissionNames(o.deny.bitfield);
    return entry;
  });
}

function describeChannel(guild: Guild, c: GuildBasedChannel, compact: boolean) {
  const out: Record<string, unknown> = { id: c.id, name: c.name, type: typeNames[c.type] ?? String(c.type) };
  if ('topic' in c && c.topic) out.topic = c.topic.slice(0, 120);
  if ('nsfw' in c && c.nsfw) out.nsfw = true;
  if ('rateLimitPerUser' in c && c.rateLimitPerUser) out.slowmode = c.rateLimitPerUser;
  if ('userLimit' in c && c.userLimit) out.user_limit = c.userLimit;
  if (c instanceof GuildChannel && !compact) {
    if (c.parent && c.permissionsLocked) out.synced_with_category = true;
    else {
      const ow = overwrites(guild, c);
      if (ow.length) out.permissions = ow;
    }
  }
  return out;
}

/**
 * JSON description of the server the AI uses as context.
 * compact drops permission details so big servers still fit small local models.
 */
export function buildSnapshot(guild: Guild, compact = false): Record<string, unknown> {
  const me = guild.members.me;
  const settings = getGuild(guild.id);
  const all = [...guild.channels.cache.values()].filter((c) => !c.isThread());
  const sorted = (list: GuildBasedChannel[]) =>
    list.sort((a, b) => ('position' in a && 'position' in b ? a.position - b.position : 0));

  const categories = sorted(all.filter((c): c is CategoryChannel => c.type === ChannelType.GuildCategory));
  let budget = MAX_CHANNELS;
  const layout = categories.map((cat) => {
    const children = sorted(all.filter((c) => c.parentId === cat.id));
    const shown = children.slice(0, Math.max(0, budget));
    budget -= shown.length;
    const entry: Record<string, unknown> = {
      id: cat.id,
      name: cat.name,
      channels: shown.map((c) => describeChannel(guild, c, compact)),
    };
    const ow = compact ? [] : overwrites(guild, cat as unknown as GuildChannel);
    if (ow.length) entry.permissions = ow;
    if (shown.length < children.length) entry.more_channels_not_shown = children.length - shown.length;
    return entry;
  });
  const uncategorized = sorted(all.filter((c) => c.type !== ChannelType.GuildCategory && !c.parentId))
    .slice(0, Math.max(10, budget))
    .map((c) => describeChannel(guild, c, compact));

  const roles = [...guild.roles.cache.values()]
    .sort((a, b) => b.position - a.position)
    .slice(0, 120)
    .map((r) => {
      const entry: Record<string, unknown> = { id: r.id, name: r.id === guild.id ? '@everyone' : r.name, position: r.position };
      if (r.color) entry.color = `#${r.color.toString(16).padStart(6, '0')}`;
      if (r.hoist) entry.hoist = true;
      if (r.mentionable) entry.mentionable = true;
      if (r.managed) entry.managed_by_integration = true;
      if (me && r.position >= me.roles.highest.position) entry.above_bot = true;
      const perms = permissionNames(r.permissions.bitfield);
      if (compact) {
        if (isDangerous(r.permissions.bitfield)) entry.staff = true;
      } else if (perms.length) entry.permissions = perms.length > 12 ? [...perms.slice(0, 12), `...+${perms.length - 12}`] : perms;
      return entry;
    });

  const automod = guild.autoModerationRules.cache.map((r) => ({
    id: r.id,
    name: r.name,
    trigger_type: r.triggerType,
    enabled: r.enabled,
    keywords: r.triggerMetadata.keywordFilter?.slice(0, 20),
  }));

  const channelName = (id?: string | null) => (id ? `#${guild.channels.cache.get(id)?.name ?? id}` : null);
  const roleName = (id: string) => guild.roles.cache.get(id)?.name ?? id;

  return {
    server: {
      id: guild.id,
      name: guild.name,
      description: guild.description,
      member_count: guild.memberCount,
      boost_tier: guild.premiumTier,
      community_enabled: guild.features.includes('COMMUNITY'),
      onboarding_available: guild.features.includes('COMMUNITY'),
      can_set_banner: guild.features.includes('BANNER'),
      features: guild.features,
      verification_level: GuildVerificationLevel[guild.verificationLevel],
      explicit_content_filter: GuildExplicitContentFilter[guild.explicitContentFilter],
      system_channel: channelName(guild.systemChannelId),
      rules_channel: channelName(guild.rulesChannelId),
      updates_channel: channelName(guild.publicUpdatesChannelId),
      afk_channel: channelName(guild.afkChannelId),
      preferred_locale: guild.preferredLocale,
      has_icon: !!guild.icon,
    },
    bot: {
      name: me?.displayName,
      is_admin: me?.permissions.has('Administrator') ?? false,
      highest_role: me?.roles.highest.name,
      note: 'The bot can only manage roles BELOW its highest role.',
    },
    categories: layout,
    channels_without_category: uncategorized,
    roles,
    automod_rules: automod,
    bot_features: {
      welcome: settings.welcome ? { channel: channelName(settings.welcome.channelId), message: settings.welcome.message } : null,
      goodbye: settings.goodbye ? { channel: channelName(settings.goodbye.channelId), message: settings.goodbye.message } : null,
      autorole: settings.autorole
        ? { roles: settings.autorole.roleIds.map(roleName), bot_roles: settings.autorole.botRoleIds.map(roleName) }
        : null,
      tickets: settings.tickets
        ? { category: channelName(settings.tickets.categoryId), staff_roles: settings.tickets.staffRoleIds.map(roleName) }
        : null,
    },
    bot_messages: (settings.posts ?? [])
      .filter((p) => guild.channels.cache.has(p.channelId))
      .slice(0, compact ? 15 : 30)
      .map((p) => ({ id: p.id, channel: channelName(p.channelId), kind: p.kind, title: p.title })),
    recent_changes_by_you: (settings.history ?? []).slice(0, 5).map((h) => ({
      when: h.at,
      request: h.prompt.slice(0, 200),
      summary: h.summary.slice(0, 300),
      created: h.created.slice(0, 60),
    })),
  };
}
