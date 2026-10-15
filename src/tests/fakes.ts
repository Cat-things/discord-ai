import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

/* Minimal fake discord.js objects, just enough for the executor, snapshot and planner. */

let nextId = 100000000000000000n;
const snowflake = () => String(nextId++);

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
    sent: [] as any[],
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
      return { pin: async () => undefined };
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
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement && channel.type !== ChannelType.GuildVoice) delete channel.send;
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

