import { Interaction, PermissionFlagsBits, RepliableInteraction } from 'discord.js';
import { askCommand, askModalSubmit, botsButton, botsModalSubmit, botsSelect, menuSelect } from './commands/ask';
import { autoCommand, helpCommand, modifyCommand } from './commands/misc';
import { moveContextMenu, moveSelect } from './commands/move';
import { providerAutocomplete, providerCommand, providerModalSubmit } from './commands/provider';
import { handlePlanButton } from './discord/build';
import { roleButton, roleSelect, ticketButton, verifyButton } from './discord/features';
import { errorEmbed } from './discord/ui';
import { log } from './logger';

/** Admin-only check that runs on every admin interaction (slash commands, menus, modals, approvals). */
async function requireAdmin(interaction: RepliableInteraction<'cached'>): Promise<boolean> {
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  await interaction.reply({ embeds: [errorEmbed('Only server admins (Administrator permission) can use this.')], flags: 'Ephemeral' });
  return false;
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    if (interaction.isRepliable()) await interaction.reply({ content: 'Use me inside a server.', flags: 'Ephemeral' }).catch(() => undefined);
    return;
  }

  try {
    if (interaction.isAutocomplete()) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return void (await interaction.respond([]));
      if (interaction.commandName === 'provider') await providerAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (!(await requireAdmin(interaction))) return;
      switch (interaction.commandName) {
        case 'provider':
          return await providerCommand(interaction);
        case 'ask':
          return await askCommand(interaction);
        case 'modify':
          return await modifyCommand(interaction);
        case 'auto':
          return await autoCommand(interaction);
        case 'help':
          return await helpCommand(interaction);
      }
      return;
    }

    if (interaction.isMessageContextMenuCommand()) {
      if (!(await requireAdmin(interaction))) return;
      if (interaction.commandName === 'Move message') await moveContextMenu(interaction);
      return;
    }

    const id = interaction.isMessageComponent() || interaction.isModalSubmit() ? interaction.customId : '';
    if (!id.startsWith('gs:')) return;

    // Public components anyone in the server can use.
    if (interaction.isButton()) {
      if (id.startsWith('gs:rr:')) return await roleButton(interaction);
      if (id.startsWith('gs:verify:')) return await verifyButton(interaction);
      if (id.startsWith('gs:ticket:')) return await ticketButton(interaction);
    }
    if (interaction.isStringSelectMenu() && id === 'gs:rrsel') return await roleSelect(interaction);

    // Everything else is part of the admin flows.
    if (!(await requireAdmin(interaction as RepliableInteraction<'cached'>))) return;
    if (interaction.isButton()) {
      if (id.startsWith('gs:plan:')) return await handlePlanButton(interaction);
      if (id.startsWith('gs:bots:')) return await botsButton(interaction);
    }
    if (interaction.isChannelSelectMenu() && id.startsWith('gs:move:')) return await moveSelect(interaction);
    if (interaction.isStringSelectMenu()) {
      if (id === 'gs:menu' || id === 'gs:template') return await menuSelect(interaction);
      if (id === 'gs:bots:pick') return await botsSelect(interaction);
    }
    if (interaction.isModalSubmit()) {
      if (id.startsWith('gs:provmodal:')) return await providerModalSubmit(interaction);
      if (id.startsWith('gs:askmodal:')) return await askModalSubmit(interaction);
      if (id === 'gs:botsmodal') return await botsModalSubmit(interaction);
    }
  } catch (err) {
    log.error(`Interaction ${interaction.id} failed`, err);
    if (!interaction.isRepliable()) return;
    const payload = { embeds: [errorEmbed(err instanceof Error ? err.message.slice(0, 1500) : 'Unknown error')] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => undefined);
    else await interaction.reply({ ...payload, flags: 'Ephemeral' }).catch(() => undefined);
  }
}
