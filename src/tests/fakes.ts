import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

/* Minimal fake discord.js objects, just enough for the executor, snapshot and planner. */

let nextId = 100000000000000000n;
export const snowflake = () => String(nextId++);

const asEmbed = (e: any) => {
  const data = e?.data ?? e;
  return { data, title: data.title ?? null, toJSON: () => data };
};
const asComponent = (c: any) => ({ toJSON: () => (typeof c?.toJSON === 'function' ? c.toJSON() : c) });

/** A message in a fake channel. author defaults to a regular user. */
export function fakeMessage(channel: any, data: any = {}) {
  const author = data.author ?? { id: '900000000000000001', username: 'alice', displayName: 'Alice' };
  author.displayAvatarURL ??= () => `https://cdn.example/avatars/${author.id}.png`;
  const msg: any = {
    id: snowflake(),
    channelId: channel.id,
    channel,
    author,
    member: data.member,
    webhookId: data.webhookId ?? null,
    system: !!data.system,
    content: data.content ?? '',
    embeds: (data.embeds ?? []).map(asEmbed),
    components: (data.components ?? []).map(asComponent),
    attachments: new Collection<string, any>((data.attachments ?? []).map((a: any) => [a.id ?? snowflake(), a])),
    stickers: new Collection(),
    poll: null,
    createdTimestamp: data.createdTimestamp ?? Date.now(),
    get url() {
      return `https://discord.com/channels/${channel.guild.id}/${channel.id}/${msg.id}`;
    },
    async delete() {
      if (!channel.messageStore.has(msg.id)) throw new Error('Unknown Message');
      channel.messageStore.delete(msg.id);
    },
    async edit(e: any) {
      if (e.content !== undefined) msg.content = e.content ?? '';
      if (e.embeds) msg.embeds = e.embeds.map(asEmbed);
      msg.lastEdit = e;
      return msg;
    },
    async pin() {},
  };
  channel.messageStore.set(msg.id, msg);
  return msg;
}

export function fakeRole(guild: any, data: { id?: string; name: string; position: number; permissions?: bigint; managed?: boolean }) {
  const role: any = {
    id: data.id ?? snowflake(),
    name: data.name,
    position: data.position,
    permissions: new PermissionsBitField(data.permissions ?? 0n),
    managed: !!data.managed,
    color: 0,
    hoist: false,
    mentionable: false,
    get editable() {
      return role.position < guild.members.me.roles.highest.position;
    },
    async edit(opts: any) {
      if (opts.name) role.name = opts.name;
      if (opts.permissions !== undefined) role.permissions = new PermissionsBitField(opts.permissions);
      role.lastEdit = opts;
      return role;
    },
    async delete() {
      guild.roles.cache.delete(role.id);
    },
    async setPosition(p: number) {
      role.position = p;
    },
  };
  return role;
}

export function fakeChannel(guild: any, opts: any) {
  const overwrites = new Collection<string, any>();
  const toOw = (o: any) => ({ id: o.id, type: o.type, allow: new PermissionsBitField(o.allow ?? 0n), deny: new PermissionsBitField(o.deny ?? 0n) });
  for (const o of opts.permissionOverwrites ?? []) overwrites.set(o.id, toOw(o));
  const channel: any = {
    id: snowflake(),
    name: opts.type === ChannelType.GuildText || opts.type === undefined ? String(opts.name).toLowerCase().replace(/\s+/g, '-') : opts.name,
    type: opts.type ?? ChannelType.GuildText,
    parentId: opts.parent ?? null,
    get parent() {
      return channel.parentId ? guild.channels.cache.get(channel.parentId) : null;
    },
    topic: opts.topic ?? null,
    position: guild.channels.cache.size,
    guild,
    get client() {
      return guild.client;
    },
    sent: [] as any[],
    messageStore: new Collection<string, any>(),
    webhooks: new Collection<string, any>(),
    messages: {
      async fetch(arg: any) {
        if (typeof arg === 'string') {
          const found = channel.messageStore.get(arg);
          if (!found) throw new Error('Unknown Message');
          return found;
        }
        const newestFirst = [...channel.messageStore.values()].reverse().slice(0, arg?.limit ?? 50);
        return new Collection(newestFirst.map((m: any) => [m.id, m]));
      },
    },
    async fetchWebhooks() {
      return channel.webhooks;
    },
    async createWebhook(opts: any) {
      const hook: any = {
        id: snowflake(),
        name: opts.name,
        token: 'hook-token',
        owner: { id: guild.client.user.id },
        sent: [] as any[],
        async send(payload: any) {
          hook.sent.push(payload);
          return fakeMessage(channel, { ...payload, author: { id: hook.id, username: payload.username }, webhookId: hook.id });
        },
      };
      channel.webhooks.set(hook.id, hook);
      return hook;
    },
    async bulkDelete(ids: string[]) {
      const removed = new Collection<string, any>();
      for (const id of ids) {
        const m = channel.messageStore.get(id);
        if (m) {
          channel.messageStore.delete(id);
          removed.set(id, m);
        }
      }
      channel.bulkDeleted = (channel.bulkDeleted ?? 0) + removed.size;
      return removed;
    },
    permissionOverwrites: {
      cache: overwrites,
      async set(list: any[]) {
        overwrites.clear();
        for (const o of list) overwrites.set(o.id, toOw(o));
      },
      async edit(id: string, flags: Record<string, boolean>, extra: any) {
        const cur = overwrites.get(id) ?? toOw({ id, type: extra?.type, allow: 0n, deny: 0n });
        let allow = cur.allow.bitfield;
        let deny = cur.deny.bitfield;
        for (const [k, v] of Object.entries(flags)) {
          const bit = (PermissionFlagsBits as any)[k];
          if (v) {
            allow |= bit;
            deny &= ~bit;
          } else {
            deny |= bit;
            allow &= ~bit;
          }
        }
        overwrites.set(id, toOw({ id, type: cur.type, allow, deny }));
      },
      async delete(id: string) {
        overwrites.delete(id);
      },
    },
    isThread: () => false,
    isTextBased: () => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice].includes(channel.type),
    async send(payload: any) {
      channel.sent.push(payload);
      return fakeMessage(channel, { ...payload, author: { id: guild.client.user.id, username: 'GuildSmith', displayName: 'GuildSmith' } });
    },
    async delete() {
      guild.channels.cache.delete(channel.id);
    },
    async edit(e: any) {
      if (e.name) channel.name = e.name;
      if (e.parent !== undefined) channel.parentId = e.parent;
      channel.lastEdit = e;
    },
    async lockPermissions() {},
    get children() {
      return { cache: guild.channels.cache.filter((c: any) => c.parentId === channel.id) };
    },
    permissionsFor: () => ({ has: () => true }),
  };
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement && channel.type !== ChannelType.GuildVoice) {
    delete channel.send;
    delete channel.createWebhook;
  }
  return channel;
}

export function fakeGuild({ botAdmin }: { botAdmin: boolean }) {
  const guild: any = {
    id: snowflake(),
    name: 'Test Server',
    ownerId: 'owner',
    features: [] as string[],
    verificationLevel: 0,
    memberCount: 42,
    edits: [] as any[],
    automod: [] as any[],
    client: { user: { id: 'bot-user' } },
  };
  const everyone = fakeRole(guild, { id: guild.id, name: '@everyone', position: 0, permissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages });
  const roles = new Collection<string, any>([[everyone.id, everyone]]);
  const botRole = fakeRole(guild, {
    name: 'GuildSmith',
    position: 10,
    permissions: botAdmin
      ? PermissionFlagsBits.Administrator
      : PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.KickMembers,
  });
  roles.set(botRole.id, botRole);
  const owner = fakeRole(guild, { name: 'Owner', position: 20, permissions: PermissionFlagsBits.Administrator });
  roles.set(owner.id, owner);
  const oldMod = fakeRole(guild, { name: 'Old Mod', position: 5, permissions: PermissionFlagsBits.KickMembers });
  roles.set(oldMod.id, oldMod);
  const admins = fakeRole(guild, { name: 'Admins', position: 3, permissions: PermissionFlagsBits.Administrator });
  roles.set(admins.id, admins);

  guild.roles = {
    cache: roles,
    everyone,
    async create(opts: any) {
      for (const r of roles.values()) if (r.id !== guild.id && r.id !== botRole.id && r.id !== owner.id) r.position++;
      const role = fakeRole(guild, { name: opts.name, position: 1, permissions: opts.permissions });
      role.createOpts = opts;
      roles.set(role.id, role);
      return role;
    },
  };
  const channels = new Collection<string, any>();
  guild.channels = {
    cache: channels,
    async create(opts: any) {
      const ch = fakeChannel(guild, opts);
      ch.createOpts = opts;
      channels.set(ch.id, ch);
      return ch;
    },
  };
  const me: any = {
    id: 'bot-user',
    permissions: { bitfield: botRole.permissions.bitfield, has: (p: any) => botRole.permissions.has(p) },
    roles: { highest: botRole },
  };
  guild.members = { me, fetchMe: async () => me, editMe: async () => me, fetch: async () => new Collection() };
  guild.autoModerationRules = {
    cache: new Collection(),
    async create(opts: any) {
      guild.automod.push(opts);
      return { id: snowflake(), name: opts.name };
    },
    fetch: async () => new Collection(),
  };
  guild.edit = async (opts: any) => {
    guild.edits.push(opts);
    if (opts.features) guild.features = opts.features;
    return guild;
  };
  guild.fetch = async () => guild;
  guild.editOnboarding = async (opts: any) => {
    guild.onboarding = opts;
  };
  return { guild, actor: { id: 'owner', roles: { highest: owner } }, oldMod, admins };
}

