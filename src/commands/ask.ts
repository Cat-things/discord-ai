import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  LabelBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { BOT_CATALOG, botInviteUrl, lookupApplication, parseClientId } from '../discord/bots';
import { runAiRequest } from '../discord/build';
import { BotLink } from '../discord/executor';
import { COLORS, errorEmbed, fitLines, infoEmbed, linkRows, truncate } from '../discord/ui';

interface Feature {
  id: string;
  label: string;
  emoji: string;
  description: string;
  /** Prefilled text in the modal; the admin can tweak it before sending. */
  defaultPrompt: string;
  focus?: string;
}

export const FEATURES: Feature[] = [
  {
    id: 'build',
    label: 'Build / extend the server',
    emoji: '🏗️',
    description: 'Describe your server and the AI builds it',
    defaultPrompt: '',
  },
  { id: 'templates', label: 'Quick-start templates', emoji: '⚡', description: 'Gaming, community, study, business and more', defaultPrompt: '' },
  { id: 'bots', label: 'Add bots', emoji: '🤖', description: 'MEE6, Carl-bot, Ticket Tool... one-click invites', defaultPrompt: '' },
  {
    id: 'welcome',
    label: 'Welcome & goodbye messages',
    emoji: '👋',
    description: 'Greet new members automatically',
    defaultPrompt:
      'Set up welcome messages in a #welcome channel (create it if missing) with a friendly embed that greets {user}, says they are member #{membercount} and points them to the rules. Also post a short goodbye message there when someone leaves.',
    focus: 'Only set up welcome/goodbye: setup_welcome, setup_goodbye and the channel if it is missing.',
  },
  {
    id: 'autorole',
    label: 'Auto join role',
    emoji: '🎭',
    description: 'Give new members a role on join',
    defaultPrompt: "Automatically give every new member a 'Member' role (create it if missing) and give new bots a 'Bots' role.",
    focus: 'Only set up auto roles: setup_autorole plus any roles it needs.',
  },
  {
    id: 'automod',
    label: 'AutoMod',
    emoji: '🛡️',
    description: 'Word filters, anti-spam, anti mention-raid',
    defaultPrompt:
      'Set up Discord AutoMod: block profanity, slurs and sexual content with the preset filter, block spam, block messages with more than 5 mentions and time the sender out for 10 minutes, and send alerts to a private #mod-logs channel only staff can see.',
    focus: 'Only set up AutoMod rules (create_automod_rule) and a log channel if needed.',
  },
  {
    id: 'community',
    label: 'Community mode',
    emoji: '🌐',
    description: 'Unlock announcements, onboarding, insights',
    defaultPrompt: 'Enable Community mode. Create #rules (with well written rules) and #mod-updates channels first if they do not exist.',
    focus: 'Enable community mode (enable_community) and create the rules/updates channels it needs.',
  },
  {
    id: 'onboarding',
    label: 'Onboarding',
    emoji: '🧭',
    description: 'Questions that hand out roles & channels',
    defaultPrompt:
      'Set up Discord Onboarding with 2-3 questions (for example interests, region and which pings they want) that give matching roles and channels. Create the roles if missing and enable Community mode first if needed.',
    focus: 'Set up onboarding (setup_onboarding) plus the roles/channels and community mode it needs.',
  },
  {
    id: 'profile',
    label: 'Server profile info',
    emoji: '🪪',
    description: 'Name, description, icon, banner, locale',
    defaultPrompt: 'Write a catchy server description that fits this server and generate a matching server icon.',
    focus: 'Only edit the server profile with edit_server (name, description, icon_prompt/icon_url, banner, locale) as asked.',
  },
  {
    id: 'selfroles',
    label: 'Self-roles menu',
    emoji: '🎨',
    description: 'Members pick colors, pings and interests',
    defaultPrompt: 'Create a #roles channel with two self-role menus: one for name colors and one for interests/notification pings. Create the roles.',
    focus: 'Only build self-role menus (create_role_menu) and the roles/channel they need.',
  },
  {
    id: 'verification',
    label: 'Verification gate',
    emoji: '✅',
    description: 'Button to unlock the server, stops raids',
    defaultPrompt:
      "Add a verification gate: a 'Verified' role, a #verify channel everyone can see with a verify button, and make the other categories visible only to Verified. Give all existing human members the Verified role so nobody gets locked out.",
    focus: 'Only build the verification system: role, verify channel, create_verification, permission changes and assign_role for existing members.',
  },
  {
    id: 'tickets',
    label: 'Ticket system',
    emoji: '🎫',
    description: 'Private support tickets with staff',
    defaultPrompt: 'Create a #support channel with a ticket panel. Staff for tickets: the existing moderator/admin roles (create a Support role if there are none).',
    focus: 'Only build the ticket system: create_ticket_panel plus the channel/roles it needs.',
  },
  {
    id: 'rules',
    label: 'Rules & info channels',
    emoji: '📜',
    description: 'Rules, announcements, FAQ with nice embeds',
    defaultPrompt: 'Create an INFO category with read-only #rules, #announcements and #faq channels, each with a nicely written embed that fits this server.',
    focus: 'Only build info channels and their messages.',
  },
];

const TEMPLATES: { id: string; label: string; emoji: string; prompt: string }[] = [
  { id: 'gaming', label: 'Gaming community', emoji: '🎮', prompt: 'Build a full gaming community server: info channels with rules, general chats, LFG, clips/media, game-specific channels, voice squads, staff area, Moderator/Member roles, self-roles for games, welcome messages and AutoMod.' },
  { id: 'community', label: 'General community / hangout', emoji: '💬', prompt: 'Build a friendly general community server: info, general chat, memes, media, events, voice lounges, staff area, roles with colors, welcome messages, auto role and AutoMod.' },
  { id: 'friends', label: 'Small friend group', emoji: '🫂', prompt: 'Build a small cozy server for a friend group: a few chill text channels (general, memes, music, plans), 2-3 voice channels and a fun nickname-color self-role menu. Keep it simple, no heavy moderation.' },
  { id: 'study', label: 'Study group / school', emoji: '📚', prompt: 'Build a study server: info, homework help channels per subject, resources forum, focus/pomodoro voice rooms, study-buddy matching, Tutor/Student roles, rules and welcome messages.' },
  { id: 'business', label: 'Business / startup team', emoji: '💼', prompt: 'Build a professional workspace server: announcements, general, departments (engineering, design, marketing, sales) with private channels per team role, meeting voice rooms, resources, and a support ticket system.' },
  { id: 'creator', label: 'Content creator / streamer', emoji: '📺', prompt: 'Build a content creator fan server: announcements and stream notifications, fan chat, fan art and clips, suggestions, VIP/Subscriber/Moderator roles, a self-role menu for notification pings, welcome messages and AutoMod.' },
  { id: 'anime', label: 'Anime & manga', emoji: '🌸', prompt: 'Build an anime and manga community: info, general chat, anime discussion, manga discussion (spoiler-safe), fan art, recommendations forum, watch-party voice, color self-roles and welcome messages.' },
  { id: 'esports', label: 'Esports team', emoji: '🏆', prompt: 'Build an esports team server: public area for fans, private team area with strategy, scrims, VOD review and team voice, roles for Players/Coaches/Managers/Fans, and tryout applications via tickets.' },
  { id: 'roleplay', label: 'Roleplay', emoji: '🎭', prompt: 'Build a roleplay server: rules and lore channels, character sheets forum, multiple RP location channels, OOC chat, Game Master/Roleplayer roles, verification and welcome messages.' },
  { id: 'dev', label: 'Coding / dev community', emoji: '💻', prompt: 'Build a programming community: info, general, help forums per language, showcase, code reviews, job board, voice for pair programming, language self-roles, Helper/Moderator roles and AutoMod.' },
];

export async function askCommand(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const prompt = interaction.options.getString('prompt');
  if (prompt) {
    await interaction.deferReply({ flags: 'Ephemeral' });
    return runAiRequest(interaction, { mode: 'ask', prompt });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId('gs:menu')
    .setPlaceholder('What do you want to set up?')
    .addOptions(FEATURES.map((f) => ({ label: f.label, value: f.id, description: f.description, emoji: f.emoji })));
  await interaction.reply({
    embeds: [
      infoEmbed(
        '🏗️ What should I build?',
        'Pick something below. Most options open a short form with a ready-made request you can tweak before the AI runs it.\n\nYou can also type freely: `/ask prompt: build me a cozy Minecraft server`',
      ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    flags: 'Ephemeral',
  });
}

function promptModal(customId: string, title: string, label: string, value: string, placeholder: string) {
  const input = new TextInputBuilder().setCustomId('prompt').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000).setPlaceholder(placeholder);
  if (value) input.setValue(value);
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(truncate(title, 45))
    .addLabelComponents(new LabelBuilder().setLabel(label).setDescription('Edit it however you like, then hit Submit.').setTextInputComponent(input));
}

export async function menuSelect(interaction: StringSelectMenuInteraction<'cached'>): Promise<void> {
  const choice = interaction.values[0];
  if (interaction.customId === 'gs:template') {
    const template = TEMPLATES.find((t) => t.id === choice);
    if (!template) return;
    return interaction.showModal(promptModal('gs:askmodal:build', `${template.label} template`, 'Your server', template.prompt, ''));
  }
  if (choice === 'templates') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('gs:template')
      .setPlaceholder('Pick a template')
      .addOptions(TEMPLATES.map((t) => ({ label: t.label, value: t.id, emoji: t.emoji })));
    await interaction.update({
      embeds: [infoEmbed('⚡ Quick-start templates', 'Pick a starting point. You can customize the request before the AI builds it, and it builds on top of what you already have.')],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
    return;
  }
  if (choice === 'bots') return showBotsPanel(interaction);
  const feature = FEATURES.find((f) => f.id === choice);
  if (!feature) return;
  if (feature.id === 'build') {
    return interaction.showModal(
      promptModal('gs:askmodal:build', 'Build / extend the server', 'Describe your server', '', 'A chill Minecraft community with build showcases, events, voice channels and a staff team...'),
    );
  }
  return interaction.showModal(promptModal(`gs:askmodal:${feature.id}`, `${feature.emoji} ${feature.label}`, 'What should I do?', feature.defaultPrompt, ''));
}

export async function askModalSubmit(interaction: ModalSubmitInteraction<'cached'>): Promise<void> {
  const featureId = interaction.customId.split(':')[2];
  const feature = FEATURES.find((f) => f.id === featureId);
  const prompt = interaction.fields.getTextInputValue('prompt').trim();
  await interaction.deferReply({ flags: 'Ephemeral' });
  if (featureId === 'botsai') {
    return runAiRequest(interaction, {
      mode: 'ask',
      prompt: `Recommend Discord bots for this server. ${prompt}`,
      focus: 'Only use recommend_bots (at most 8 bots that really fit). No other actions. Explain your picks in "reply".',
      title: '🤖 Bot picks',
    });
  }
  await runAiRequest(interaction, { mode: 'ask', prompt, focus: feature?.focus, title: feature && feature.id !== 'build' ? `${feature.emoji} ${feature.label}` : undefined });
}

/* ------------------------------------------------------------------------------------------------ */
/* Bots                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

async function showBotsPanel(interaction: StringSelectMenuInteraction<'cached'>) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('gs:bots:pick')
    .setPlaceholder('Pick the bots you want (multiple allowed)')
    .setMinValues(1)
    .setMaxValues(BOT_CATALOG.length)
    .addOptions(BOT_CATALOG.map((b) => ({ label: b.name, value: b.clientId, description: truncate(`${b.category} · ${b.description}`, 100) })));
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('gs:bots:custom').setLabel('Custom bot (ID or invite link)').setEmoji('➕').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gs:bots:ai').setLabel('Let the AI pick for my server').setEmoji('🧠').setStyle(ButtonStyle.Primary),
  );
  await interaction.update({
    embeds: [
      infoEmbed(
        '🤖 Add bots',
        [
          'Pick bots and I\'ll make **one-click invite links** with this server already selected and the right permissions filled in.',
          '',
          '**Why not 100% automatic?** Discord requires a real person to press **Authorize** for every bot (sometimes with a captcha). No bot or OAuth app is allowed to skip that, and scripting your user account to do it is self-botting, which gets accounts banned. So: you pick, I prepare everything, you click once per bot.',
          '',
          '**Manual way:** open the bot\'s website (or top.gg), hit *Invite*, choose this server.',
        ].join('\n'),
      ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), buttons],
  });
}

async function linksFor(guildId: string, entries: { clientId: string; permissions?: string; note?: string }[]): Promise<{ links: BotLink[]; lines: string[] }> {
  const links: BotLink[] = [];
  const lines: string[] = [];
  for (const entry of entries.slice(0, 25)) {
    const known = BOT_CATALOG.find((b) => b.clientId === entry.clientId);
    const real = await lookupApplication(entry.clientId);
    const name = real?.name ?? known?.name ?? `App ${entry.clientId}`;
    links.push({ label: name, url: botInviteUrl(entry.clientId, guildId, entry.permissions ?? known?.permissions ?? '8') });
    lines.push(`• **${name}**${known ? ` — ${known.description}` : ''}${real ? '' : ' *(couldn\'t verify the name with Discord, check it on the authorize page)*'}`);
  }
  return { links, lines };
}

export async function botsSelect(interaction: StringSelectMenuInteraction<'cached'>): Promise<void> {
  await interaction.deferReply({ flags: 'Ephemeral' });
  const { links, lines } = await linksFor(interaction.guildId, interaction.values.map((clientId) => ({ clientId })));
  await interaction.editReply({
    embeds: [infoEmbed('🔗 Your invite links', fitLines(['Click each button, then **Authorize** (server is pre-selected):', '', ...lines]), COLORS.ok)],
    components: linkRows(links),
  });
}

export async function botsButton(interaction: ButtonInteraction<'cached'>): Promise<void> {
  if (interaction.customId === 'gs:bots:custom') {
    const input = new TextInputBuilder()
      .setCustomId('ids')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setPlaceholder('123456789012345678\nhttps://discord.com/oauth2/authorize?client_id=...')
      .setMaxLength(2000);
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('gs:botsmodal')
        .setTitle('Add custom bots')
        .addLabelComponents(new LabelBuilder().setLabel('Client IDs or invite links').setDescription('One per line. Find them on the bot\'s website or top.gg.').setTextInputComponent(input)),
    );
    return;
  }
  if (interaction.customId === 'gs:bots:ai') {
    await interaction.showModal(promptModal('gs:askmodal:botsai', 'AI bot picks', 'What do you need bots for?', 'Music, leveling, moderation and fun games.', ''));
  }
}

export async function botsModalSubmit(interaction: ModalSubmitInteraction<'cached'>): Promise<void> {
  await interaction.deferReply({ flags: 'Ephemeral' });
  const raw = interaction.fields.getTextInputValue('ids').split(/[\s,]+/).filter(Boolean);
  const parsed = raw.map((r) => parseClientId(r)).filter((x): x is NonNullable<typeof x> => !!x);
  if (!parsed.length) {
    await interaction.editReply({ embeds: [errorEmbed('I couldn\'t find any client IDs or invite links in that. A client ID is a 17-20 digit number.')] });
    return;
  }
  const { links, lines } = await linksFor(interaction.guildId, parsed);
  await interaction.editReply({
    embeds: [infoEmbed('🔗 Your invite links', fitLines(['Click each button, then **Authorize** (server is pre-selected):', '', ...lines]), COLORS.ok)],
    components: linkRows(links),
  });
}
