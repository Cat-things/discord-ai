import { ChatInputCommandInteraction } from 'discord.js';
import { resolveGuildProvider } from '../ai/guild';
import { config } from '../config';
import { runAiRequest } from '../discord/build';
import { COLORS, infoEmbed } from '../discord/ui';
import { updateGuild } from '../storage/db';

export async function modifyCommand(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  await interaction.deferReply({ flags: 'Ephemeral' });
  await runAiRequest(interaction, { mode: 'modify', prompt: interaction.options.getString('prompt', true) });
}

export async function autoCommand(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const enabled = interaction.options.getBoolean('enabled', true);
  updateGuild(interaction.guildId, (g) => {
    g.autoMode = { enabled, by: interaction.user.id, at: new Date().toISOString() };
  });
  const embed = enabled
    ? infoEmbed(
        '🟢 Auto mode ON',
        [
          'From now on, **every AI action runs without asking**, including destructive ones: deleting or editing channels and roles, changing permissions, server settings, Community mode and Onboarding.',
          '',
          '⚠️ A vague request like "clean up the server" can delete stuff for real. There is no undo button, so be specific.',
          '',
          'Turn it off anytime with `/auto enabled:false`.',
        ].join('\n'),
        COLORS.warn,
      )
    : infoEmbed('⚪ Auto mode OFF', 'I\'ll show you a preview and ask before running anything destructive.', COLORS.ok);
  await interaction.reply({ embeds: [embed], flags: 'Ephemeral' });
}

export async function helpCommand(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  let providerLine: string;
  try {
    const p = resolveGuildProvider(interaction.guildId);
    providerLine = `${p.info.emoji} ${p.info.name} · \`${p.model}\``;
  } catch (err) {
    providerLine = `❌ ${(err as Error).message}`;
  }
  const lines = [
    `**${config.botName}** builds and manages your Discord server with AI.`,
    '',
    '**Commands** (admins only)',
    '`/provider set` — pick the AI (Gemini, Grok, Groq, OpenAI, Anthropic, OpenRouter, fal, Qwen, DeepSeek, Mistral, Z.AI or free local Ollama)',
    '`/provider status | test | model | reset` — check or tweak the AI setup',
    '`/ask prompt:...` — build the server or add on top of it',
    '`/ask` (no prompt) — menu: templates, bots, welcome, auto role, AutoMod, Community, Onboarding, server profile, self-roles, verification, tickets, announcements, moving messages, rules',
    '`/modify prompt:...` — change existing stuff, or things I built earlier ("undo the last build", "move the ticket panel to #support")',
    '**Right-click a message → Apps → Move message** — move or copy any message or panel to another channel',
    '`/auto enabled:true|false` — skip the approval step for destructive actions',
    '',
    '**Good to know**',
    '• Creating things and posting messages runs right away. Deleting/editing/moving existing things and pings ask first (unless auto mode is on).',
    '• Moving other people\'s messages needs **Message Content Intent** turned on in the Developer Portal.',
    '• Give me **Administrator** and drag my role to the **top** of the role list so I can manage everything.',
    '• Welcome messages, auto roles, role menus, verification and tickets keep working only while I\'m online.',
    '',
    `**Current AI:** ${providerLine}`,
  ];
  await interaction.reply({ embeds: [infoEmbed(`❓ ${config.botName} help`, lines.join('\n'))], flags: 'Ephemeral' });
}
