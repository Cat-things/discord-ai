import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { log } from '../logger';

export interface ProviderSettings {
  id: string;
  model?: string;
  /** Encrypted with storage/crypto. Never stored in plain text. */
  apiKey?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface WelcomeSettings {
  channelId: string;
  message: string;
  embed: boolean;
  title?: string;
  color?: number;
  imageUrl?: string;
  dmMessage?: string;
}

export interface GoodbyeSettings {
  channelId: string;
  message: string;
  embed: boolean;
}

export interface TicketSettings {
  categoryId?: string;
  staffRoleIds: string[];
  counter: number;
}

export interface HistoryEntry {
  at: string;
  by: string;
  prompt: string;
  summary: string;
  created: { kind: string; id: string; name: string }[];
  changed: string[];
}

/** Messages the bot posted (panels, announcements...), so the AI can move/edit/delete them later. */
export interface BotPost {
  id: string;
  channelId: string;
  kind: 'message' | 'verification' | 'tickets' | 'role_menu';
  title: string;
  at: string;
}

export interface GuildSettings {
  provider?: ProviderSettings;
  autoMode?: { enabled: boolean; by?: string; at?: string };
  welcome?: WelcomeSettings;
  goodbye?: GoodbyeSettings;
  autorole?: { roleIds: string[]; botRoleIds: string[] };
  tickets?: TicketSettings;
  history?: HistoryEntry[];
  posts?: BotPost[];
}

interface Schema {
  version: 1;
  guilds: Record<string, GuildSettings>;
}

const file = path.join(config.dataDir, 'db.json');
let state: Schema = { version: 1, guilds: {} };
let saveTimer: NodeJS.Timeout | null = null;

export function loadDb(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(file)) return;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8')) as Schema;
    state.guilds ??= {};
  } catch (err) {
    const backup = `${file}.broken-${Date.now()}`;
    fs.copyFileSync(file, backup);
    log.error(`Could not read ${file} (backed up to ${backup}). Starting with an empty database.`, err);
  }
}

function flush(): void {
  saveTimer = null;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try {
      flush();
    } catch (err) {
      log.error('Failed to save database', err);
    }
  }, 250);
}

/** Writes any pending changes immediately (used on shutdown). */
export function flushDb(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    flush();
  }
}

export function getGuild(guildId: string): GuildSettings {
  return state.guilds[guildId] ?? {};
}

/** Mutates a guild's settings in place and persists them. */
export function updateGuild(guildId: string, mutate: (settings: GuildSettings) => void): GuildSettings {
  const settings = (state.guilds[guildId] ??= {});
  mutate(settings);
  scheduleSave();
  return settings;
}

export function addHistory(guildId: string, entry: HistoryEntry): void {
  updateGuild(guildId, (g) => {
    g.history = [entry, ...(g.history ?? [])].slice(0, 10);
  });
}

export function forgetGuild(guildId: string): void {
  delete state.guilds[guildId];
  scheduleSave();
}
