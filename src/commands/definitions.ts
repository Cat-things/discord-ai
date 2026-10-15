import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { providerChoices } from '../ai/providers';

const adminOnly = (b: SlashCommandBuilder) =>
  b.setDefaultMemberPermissions(PermissionFlagsBits.Administrator).setContexts(InteractionContextType.Guild);

export const commandDefinitions = [
  adminOnly(new SlashCommandBuilder().setName('provider').setDescription('Set up the AI provider this server uses'))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Pick an AI provider (asks for the API key privately)')
        .addStringOption((o) => o.setName('provider').setDescription('Which AI to use').setRequired(true).addChoices(...providerChoices()))
        .addStringOption((o) => o.setName('model').setDescription('Model id (leave empty to auto-pick the best one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('model')
        .setDescription('Change the model of the current provider')
        .addStringOption((o) => o.setName('model').setDescription('Model id').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Show the current AI provider, model and auto mode'))
    .addSubcommand((s) => s.setName('test').setDescription('Send a tiny test prompt to check the provider works'))
    .addSubcommand((s) => s.setName('reset').setDescription('Forget this server\'s provider and API key')),

  adminOnly(new SlashCommandBuilder().setName('ask').setDescription('Ask the AI to build your server or add on top of it (no prompt = feature menu)')).addStringOption(
    (o) => o.setName('prompt').setDescription('e.g. "Build a cozy Minecraft community server" (leave empty for the menu)').setMaxLength(2000),
  ),

  adminOnly(new SlashCommandBuilder().setName('modify').setDescription('Ask the AI to change existing channels, roles, settings or its earlier changes')).addStringOption(
    (o) => o.setName('prompt').setDescription('e.g. "Make the voice channels private to Members" or "undo the last build"').setRequired(true).setMaxLength(2000),
  ),

  adminOnly(new SlashCommandBuilder().setName('auto').setDescription('Auto mode: always allow destructive AI actions without asking')).addBooleanOption((o) =>
    o.setName('enabled').setDescription('Turn auto mode on or off').setRequired(true),
  ),

  adminOnly(new SlashCommandBuilder().setName('help').setDescription('How to use this bot')),
];
