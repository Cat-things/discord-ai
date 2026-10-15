import { ChannelType, Colors, Guild, GuildBasedChannel, Role } from 'discord.js';

export interface PlanKeys {
  channels: Map<string, string>;
  roles: Map<string, string>;
}

export const newKeys = (): PlanKeys => ({ channels: new Map(), roles: new Map() });

/** Lowercase letters and digits only, so "💬・General Chat", "#general-chat" and "general chat" all match. */
export const loose = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');

const snowflake = /^\d{17,20}$/;

function stripMention(ref: string): string {
  const m = /^<(?:#|@&|@!?)(\d{17,20})>$/.exec(ref.trim());
  return m ? m[1] : ref.trim().replace(/^#/, '');
}

export function resolveRole(guild: Guild, keys: PlanKeys, ref: string | undefined): Role | undefined {
  if (!ref) return undefined;
  const raw = ref.trim();
  if (['@everyone', 'everyone', '@ everyone'].includes(raw.toLowerCase())) return guild.roles.everyone;
  const keyed = keys.roles.get(raw.toLowerCase());
  if (keyed) return guild.roles.cache.get(keyed);
  const cleaned = stripMention(raw).replace(/^@/, '');
  if (snowflake.test(cleaned)) return guild.roles.cache.get(cleaned);
  const roles = [...guild.roles.cache.values()];
  return (
    roles.find((r) => r.name === cleaned) ??
    roles.find((r) => r.name.toLowerCase() === cleaned.toLowerCase()) ??
    (loose(cleaned) ? roles.find((r) => loose(r.name) === loose(cleaned)) : undefined)
  );
}

export function resolveChannel(
  guild: Guild,
  keys: PlanKeys,
  ref: string | undefined | null,
  want: 'any' | 'category' | 'notCategory' = 'any',
): GuildBasedChannel | undefined {
  if (!ref) return undefined;
  const fits = (c: GuildBasedChannel | undefined): c is GuildBasedChannel => {
    if (!c || c.isThread()) return false;
    if (want === 'category') return c.type === ChannelType.GuildCategory;
    if (want === 'notCategory') return c.type !== ChannelType.GuildCategory;
    return true;
  };
  const raw = ref.trim();
  const keyed = keys.channels.get(raw.toLowerCase()) ?? keys.channels.get(raw.replace(/^#/, '').toLowerCase());
  if (keyed && fits(guild.channels.cache.get(keyed))) return guild.channels.cache.get(keyed);
  const cleaned = stripMention(raw);
  if (snowflake.test(cleaned)) {
    const byId = guild.channels.cache.get(cleaned);
    return fits(byId) ? byId : undefined;
  }

  const candidates = [...guild.channels.cache.values()].filter(fits);
  const dashed = cleaned.toLowerCase().replace(/\s+/g, '-');
  return (
    candidates.find((c) => c.name === cleaned) ??
    candidates.find((c) => c.name.toLowerCase() === cleaned.toLowerCase() || c.name.toLowerCase() === dashed) ??
    (loose(cleaned) ? candidates.find((c) => loose(c.name) === loose(cleaned)) : undefined)
  );
}

const colorNames = new Map(Object.entries(Colors).map(([k, v]) => [loose(k), v]));

export function resolveColor(input: string | number | undefined): number | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.max(0, Math.min(0xffffff, Math.round(input))) : undefined;
  const s = input.trim();
  const hex = /^(?:#|0x)?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return Number.parseInt(h, 16);
  }
  return colorNames.get(loose(s));
}

/** Fetches an image from a public https URL (no local/private hosts) for icons and banners. */
export async function fetchImage(url: string): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  const host = parsed.hostname.toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host.startsWith('[') ||
    host === '::1';
  if (parsed.protocol !== 'https:' || privateHost) throw new Error('Images must come from a public https:// URL.');
  const res = await fetch(parsed, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`Image download failed (${res.status}).`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) throw new Error(`That URL is not an image (${type || 'unknown type'}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 10 * 1024 * 1024) throw new Error('Image is larger than 10 MB.');
  return buf;
}
