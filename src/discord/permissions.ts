import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';

type PermName = keyof typeof PermissionFlagsBits;

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

const lookup = new Map<string, PermName>();
for (const name of Object.keys(PermissionFlagsBits) as PermName[]) lookup.set(normalize(name), name);

// Common names models (and humans) use that differ from discord.js flag names.
const aliases: Record<string, PermName> = {
  admin: 'Administrator',
  manageserver: 'ManageGuild',
  readmessages: 'ViewChannel',
  viewchannels: 'ViewChannel',
  view: 'ViewChannel',
  read: 'ViewChannel',
  sendmessage: 'SendMessages',
  send: 'SendMessages',
  talk: 'SendMessages',
  readhistory: 'ReadMessageHistory',
  timeoutmembers: 'ModerateMembers',
  timeout: 'ModerateMembers',
  manageemojis: 'ManageGuildExpressions',
  manageemojisandstickers: 'ManageGuildExpressions',
  manageexpressions: 'ManageGuildExpressions',
  voiceactivity: 'UseVAD',
  usevoiceactivity: 'UseVAD',
  video: 'Stream',
  embed: 'EmbedLinks',
  externalemojis: 'UseExternalEmojis',
  externalstickers: 'UseExternalStickers',
  slashcommands: 'UseApplicationCommands',
  useslashcommands: 'UseApplicationCommands',
  createthreads: 'CreatePublicThreads',
  usepublicthreads: 'CreatePublicThreads',
  useprivatethreads: 'CreatePrivateThreads',
  createinvite: 'CreateInstantInvite',
  createinvites: 'CreateInstantInvite',
  managepermissions: 'ManageRoles',
  react: 'AddReactions',
  reactions: 'AddReactions',
  pin: 'PinMessages',
};
for (const [alias, name] of Object.entries(aliases)) if (name in PermissionFlagsBits) lookup.set(alias, name);

/** Permissions that let someone take over or wreck a server. Granting them always needs confirmation. */
export const DANGEROUS_PERMISSIONS = PermissionsBitField.resolve([
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'ManageWebhooks',
  'BanMembers',
  'KickMembers',
  'ModerateMembers',
  'ManageGuildExpressions',
  'MentionEveryone',
]);

export function resolvePermissionName(input: string): PermName | undefined {
  return lookup.get(normalize(input));
}

export function resolvePermissions(input: readonly string[] | undefined): { bits: bigint; names: PermName[]; unknown: string[] } {
  const names: PermName[] = [];
  const unknown: string[] = [];
  for (const raw of input ?? []) {
    const name = resolvePermissionName(String(raw));
    if (name) names.push(name);
    else unknown.push(String(raw));
  }
  return { bits: names.reduce((acc, n) => acc | PermissionFlagsBits[n], 0n), names, unknown };
}

export function isDangerous(bits: bigint): boolean {
  return (bits & DANGEROUS_PERMISSIONS) !== 0n;
}

/** Readable list of the notable permissions in a bitfield (for the AI snapshot and previews). */
export function permissionNames(bits: bigint): string[] {
  if (bits & PermissionFlagsBits.Administrator) return ['Administrator'];
  return new PermissionsBitField(bits).toArray();
}
