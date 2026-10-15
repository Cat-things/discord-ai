import { ActivityType, Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { getProvider } from './ai/providers';
import { commandDefinitions } from './commands/definitions';
import { config } from './config';
import { onMemberJoin, onMemberLeave } from './discord/features';
import { handleInteraction } from './interactions';
import { log } from './logger';
import { flushDb, loadDb } from './storage/db';

if (!config.token) {
  console.error('\n❌ DISCORD_TOKEN is missing. Copy .env.example to .env and paste your bot token in it.\n');
  process.exit(1);
}

loadDb();

const client = new Client({
  // GuildMembers is a privileged intent: enable "Server Members Intent" in the Developer Portal → Bot.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once(Events.ClientReady, async (ready) => {
  const body = commandDefinitions.map((c) => c.toJSON());
  try {
    if (config.devGuildId) {
      const guild = await ready.guilds.fetch(config.devGuildId);
      await guild.commands.set(body);
      await ready.application.commands.set([]);
      log.info(`Registered ${body.length} commands to dev server "${guild.name}" (instant).`);
    } else {
      await ready.application.commands.set(body);
      // Clean up leftovers from DEV_GUILD_ID testing so commands don't show up twice.
      for (const guild of [...ready.guilds.cache.values()].slice(0, 50)) {
        const existing = await guild.commands.fetch().catch(() => null);
        if (existing?.size) await guild.commands.set([]).catch(() => undefined);
      }
      log.info(`Registered ${body.length} global commands.`);
    }
  } catch (err) {
    log.error('Failed to register slash commands', err);
  }

  ready.user.setPresence({ activities: [{ name: '/ask to build your server', type: ActivityType.Custom }] });
  const invite = `https://discord.com/oauth2/authorize?client_id=${ready.user.id}&scope=bot+applications.commands&permissions=8`;
  const provider = getProvider(config.defaultProvider);
  log.info(`✅ ${config.botName} is online as ${ready.user.tag} in ${ready.guilds.cache.size} server(s).`);
  log.info(`   Default AI: ${provider?.name ?? config.defaultProvider}${provider?.kind === 'ollama' ? ` (${config.ollama.model} @ ${config.ollama.url})` : ''}`);
  log.info(`   Invite me: ${invite}`);
});

client.on(Events.InteractionCreate, (interaction) => void handleInteraction(interaction));
client.on(Events.GuildMemberAdd, (member) => void onMemberJoin(member).catch((err) => log.warn('[join]', err)));
client.on(Events.GuildMemberRemove, (member) => void onMemberLeave(member).catch((err) => log.warn('[leave]', err)));
client.on(Events.GuildCreate, (guild) => log.info(`Joined server "${guild.name}" (${guild.id}).`));
client.on(Events.Error, (err) => log.error('Discord client error', err));

process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection', err));

function shutdown(signal: string) {
  log.info(`${signal} received, shutting down...`);
  try {
    flushDb();
  } finally {
    void client.destroy().finally(() => process.exit(0));
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.token).catch((err: any) => {
  if (String(err?.message ?? err).toLowerCase().includes('disallowed intents') || err?.code === 4014) {
    console.error(
      '\n❌ Discord refused the "Server Members" intent.\n   Fix: https://discord.com/developers/applications → your app → Bot → turn ON "SERVER MEMBERS INTENT" → Save, then restart.\n',
    );
  } else if (String(err?.message ?? err).toLowerCase().includes('token')) {
    console.error('\n❌ Discord rejected the bot token. Reset it in the Developer Portal (Bot → Reset Token) and update DISCORD_TOKEN in .env.\n');
  } else {
    console.error('\n❌ Login failed:', err);
  }
  process.exit(1);
});
