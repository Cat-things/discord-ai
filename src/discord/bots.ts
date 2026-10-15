import { loose } from './resolve';

export interface CatalogBot {
  name: string;
  clientId: string;
  category: string;
  description: string;
  website: string;
  /** Permissions bitfield to request. 8 = Administrator, which most of these dashboards ask for. */
  permissions: string;
}

/**
 * Popular public bots. Client ids are double-checked against Discord at runtime
 * (lookupApplication) and the button shows the name Discord reports, so a stale id can't trick you.
 */
export const BOT_CATALOG: CatalogBot[] = [
  { name: 'MEE6', clientId: '159985870458322944', category: 'All-in-one', description: 'Levels, moderation, custom commands', website: 'https://mee6.xyz', permissions: '8' },
  { name: 'Carl-bot', clientId: '235148962103951360', category: 'All-in-one', description: 'Reaction roles, logging, automod, tags', website: 'https://carl.gg', permissions: '8' },
  { name: 'Dyno', clientId: '155149108183695360', category: 'Moderation', description: 'Moderation, auto roles, announcements', website: 'https://dyno.gg', permissions: '8' },
  { name: 'YAGPDB', clientId: '204255221017214977', category: 'All-in-one', description: 'Custom commands, automod, feeds', website: 'https://yagpdb.xyz', permissions: '8' },
  { name: 'ProBot', clientId: '282859044593598464', category: 'All-in-one', description: 'Welcome images, levels, moderation', website: 'https://probot.io', permissions: '8' },
  { name: 'Ticket Tool', clientId: '557628352828014614', category: 'Support', description: 'Advanced ticket system', website: 'https://tickettool.xyz', permissions: '8' },
  { name: 'Arcane', clientId: '437808476106784770', category: 'Leveling', description: 'XP / leveling with role rewards', website: 'https://arcane.bot', permissions: '8' },
  { name: 'Statbot', clientId: '491769129318088714', category: 'Stats', description: 'Server analytics and stat channels', website: 'https://statbot.net', permissions: '8' },
  { name: 'Xenon', clientId: '416358583220043796', category: 'Utility', description: 'Server backups and templates', website: 'https://xenon.bot', permissions: '8' },
  { name: 'Giveaway Bot', clientId: '294882584201003009', category: 'Engagement', description: 'Easy giveaways', website: 'https://giveawaybot.party', permissions: '347200' },
  { name: 'Dank Memer', clientId: '270904126974590976', category: 'Fun', description: 'Memes and a big currency game', website: 'https://dankmemer.lol', permissions: '379968' },
  { name: 'Mudae', clientId: '432610292342587392', category: 'Fun', description: 'Waifu / husbando collection game', website: 'https://mudae.fandom.com', permissions: '388160' },
  { name: 'Pokétwo', clientId: '716390085896962058', category: 'Fun', description: 'Catch Pokémon in chat', website: 'https://poketwo.net', permissions: '388160' },
  { name: 'Jockie Music', clientId: '411916947773587456', category: 'Music', description: 'Music player', website: 'https://www.jockiemusic.com', permissions: '36727808' },
  { name: 'Craig', clientId: '272937604339466240', category: 'Voice', description: 'Multi-track voice recording', website: 'https://craig.chat', permissions: '3148800' },
  { name: 'DISBOARD', clientId: '302050872383242240', category: 'Growth', description: 'List and bump your server', website: 'https://disboard.org', permissions: '19456' },
  { name: 'Bloxlink', clientId: '426537812993638400', category: 'Gaming', description: 'Roblox account verification', website: 'https://blox.link', permissions: '8' },
  { name: 'Wick', clientId: '536991182035746816', category: 'Security', description: 'Anti-nuke and anti-raid', website: 'https://wickbot.com', permissions: '8' },
  { name: 'Sapphire', clientId: '678344927997853742', category: 'All-in-one', description: 'Moderation, welcome, reaction roles', website: 'https://sapph.xyz', permissions: '8' },
];

export function findCatalogBot(name: string): CatalogBot | undefined {
  const n = loose(name);
  return BOT_CATALOG.find((b) => loose(b.name) === n) ?? BOT_CATALOG.find((b) => n.length >= 3 && (loose(b.name).includes(n) || n.includes(loose(b.name))));
}

/** Discord's authorize page with this server pre-selected: the admin only clicks "Authorize". */
export function botInviteUrl(clientId: string, guildId: string, permissions = '8'): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'bot applications.commands',
    permissions,
    guild_id: guildId,
    disable_guild_select: 'true',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Pulls a client id out of a raw id or any discord.com/oauth2 invite link. */
export function parseClientId(input: string): { clientId: string; permissions?: string } | undefined {
  const trimmed = input.trim();
  if (/^\d{17,20}$/.test(trimmed)) return { clientId: trimmed };
  try {
    const url = new URL(trimmed);
    const clientId = url.searchParams.get('client_id');
    if (clientId && /^\d{17,20}$/.test(clientId)) return { clientId, permissions: url.searchParams.get('permissions') ?? undefined };
  } catch {
    /* not a URL */
  }
  return undefined;
}

const appCache = new Map<string, { name: string; bot: boolean } | null>();

/** Asks Discord which application a client id really belongs to (public endpoint, no auth). */
export async function lookupApplication(clientId: string): Promise<{ name: string; bot: boolean } | null> {
  if (appCache.has(clientId)) return appCache.get(clientId)!;
  try {
    const res = await fetch(`https://discord.com/api/v10/applications/${clientId}/rpc`, { signal: AbortSignal.timeout(8000) });
    const data: any = res.ok ? await res.json() : null;
    const info = data?.name ? { name: String(data.name), bot: data.bot_public !== undefined || !!data.bot } : null;
    appCache.set(clientId, info);
    return info;
  } catch {
    return null;
  }
}
