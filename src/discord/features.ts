import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  GuildMember,
  OverwriteType,
  PartialGuildMember,
  PermissionFlagsBits,
  StringSelectMenuInteraction,
} from 'discord.js';
import { log } from '../logger';
import { getGuild, updateGuild } from '../storage/db';
import { isDangerous } from './permissions';
import { BRAND_COLOR, explainError } from './executor';
import { errorEmbed, infoEmbed } from './ui';

function fill(template: string, member: GuildMember | PartialGuildMember): string {
  return template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', member.displayName ?? member.user?.username ?? 'someone')
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{membercount}', String(member.guild.memberCount));
}

export async function onMemberJoin(member: GuildMember): Promise<void> {
  const settings = getGuild(member.guild.id);

  const roleIds = member.user.bot ? settings.autorole?.botRoleIds : settings.autorole?.roleIds;
  if (roleIds?.length) {
    // Re-check at join time: a role edited to have admin perms later must never be handed out automatically.
    const roles = roleIds.map((id) => member.guild.roles.cache.get(id)).filter((r) => r && !isDangerous(r.permissions.bitfield) && r.editable);
    if (roles.length) await member.roles.add(roles.map((r) => r!.id), 'Auto role').catch((err) => log.warn(`[autorole] ${member.guild.id}: ${explainError(err)}`));
  }

  const welcome = settings.welcome;
  if (welcome && !member.user.bot) {
    const channel = member.guild.channels.cache.get(welcome.channelId);
    if (channel?.isTextBased() && 'send' in channel) {
      const text = fill(welcome.message, member);
      const payload = welcome.embed
        ? {
            content: `<@${member.id}>`,
            embeds: [
              (() => {
                const e = new EmbedBuilder()
                  .setColor(welcome.color ?? BRAND_COLOR)
                  .setTitle(fill(welcome.title ?? `Welcome to {server}!`, member).slice(0, 256))
                  .setDescription(text.slice(0, 4096))
                  .setThumbnail(member.displayAvatarURL({ size: 256 }))
                  .setFooter({ text: `Member #${member.guild.memberCount}` });
                if (welcome.imageUrl) e.setImage(welcome.imageUrl);
                return e;
              })(),
            ],
          }
        : { content: text.slice(0, 2000) };
      await channel.send({ ...payload, allowedMentions: { users: [member.id] } }).catch((err) => log.warn(`[welcome] ${member.guild.id}: ${explainError(err)}`));
    }
    if (welcome.dmMessage) await member.send(fill(welcome.dmMessage, member).slice(0, 2000)).catch(() => undefined);
  }
}

export async function onMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
  const goodbye = getGuild(member.guild.id).goodbye;
  if (!goodbye || member.user?.bot) return;
  const channel = member.guild.channels.cache.get(goodbye.channelId);
  if (!channel?.isTextBased() || !('send' in channel)) return;
  const text = fill(goodbye.message, member);
  const payload = goodbye.embed ? { embeds: [new EmbedBuilder().setColor(0x99aab5).setDescription(text.slice(0, 4096))] } : { content: text.slice(0, 2000) };
  await channel.send({ ...payload, allowedMentions: { parse: [] } }).catch((err) => log.warn(`[goodbye] ${member.guild.id}: ${explainError(err)}`));
}

/** Makes sure a self-assignable role is still safe to hand out right now. */
function safeRole(interaction: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>, roleId: string) {
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) return { error: 'That role no longer exists. Ask an admin to update this menu.' };
  if (isDangerous(role.permissions.bitfield) || role.managed) return { error: 'That role can\'t be self-assigned anymore (it has staff permissions).' };
  if (!role.editable) return { error: 'I can\'t give that role, my role is below it. Ask an admin to move my role up.' };
  return { role };
}

export async function roleButton(interaction: ButtonInteraction<'cached'>): Promise<void> {
  const roleId = interaction.customId.split(':')[2];
  const { role, error } = safeRole(interaction, roleId);
  if (!role) return void interaction.reply({ embeds: [errorEmbed(error!)], flags: 'Ephemeral' });
  try {
    if (interaction.member.roles.cache.has(role.id)) {
      await interaction.member.roles.remove(role, 'Role menu');
      await interaction.reply({ content: `➖ Removed **${role.name}**`, flags: 'Ephemeral' });
    } else {
      await interaction.member.roles.add(role, 'Role menu');
      await interaction.reply({ content: `➕ You now have **${role.name}**`, flags: 'Ephemeral' });
    }
  } catch (err) {
    await interaction.reply({ embeds: [errorEmbed(explainError(err))], flags: 'Ephemeral' });
  }
}

export async function roleSelect(interaction: StringSelectMenuInteraction<'cached'>): Promise<void> {
  const offered = interaction.component.options.map((o) => o.value);
  const chosen = new Set(interaction.values);
  const added: string[] = [];
  const removed: string[] = [];
  const problems: string[] = [];
  for (const roleId of offered) {
    const has = interaction.member.roles.cache.has(roleId);
    if (has === chosen.has(roleId)) continue;
    const { role, error } = safeRole(interaction, roleId);
    if (!role) {
      problems.push(error!);
      continue;
    }
    try {
      if (has) {
        await interaction.member.roles.remove(role, 'Role menu');
        removed.push(role.name);
      } else {
        await interaction.member.roles.add(role, 'Role menu');
        added.push(role.name);
      }
    } catch (err) {
      problems.push(explainError(err));
    }
  }
  const parts = [added.length ? `➕ ${added.join(', ')}` : '', removed.length ? `➖ ${removed.join(', ')}` : '', ...[...new Set(problems)].map((p) => `⚠️ ${p}`)];
  await interaction.reply({ content: parts.filter(Boolean).join('\n') || 'No changes.', flags: 'Ephemeral' });
}

export async function verifyButton(interaction: ButtonInteraction<'cached'>): Promise<void> {
  const { role, error } = safeRole(interaction, interaction.customId.split(':')[2]);
  if (!role) return void interaction.reply({ embeds: [errorEmbed(error!)], flags: 'Ephemeral' });
  if (interaction.member.roles.cache.has(role.id)) return void interaction.reply({ content: '✅ You are already verified!', flags: 'Ephemeral' });
  try {
    await interaction.member.roles.add(role, 'Verification');
    await interaction.reply({ content: `✅ Verified! Welcome to **${interaction.guild.name}** 🎉`, flags: 'Ephemeral' });
  } catch (err) {
    await interaction.reply({ embeds: [errorEmbed(explainError(err))], flags: 'Ephemeral' });
  }
}

export async function ticketButton(interaction: ButtonInteraction<'cached'>): Promise<void> {
  const action = interaction.customId.split(':')[2];
  const settings = getGuild(interaction.guildId).tickets;

  if (action === 'close') {
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText || !channel.topic?.includes('ticket-owner:')) return;
    const ownerId = /ticket-owner:(\d+)/.exec(channel.topic)?.[1];
    const isStaff =
      interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      (settings?.staffRoleIds ?? []).some((id) => interaction.member.roles.cache.has(id));
    if (interaction.user.id !== ownerId && !isStaff) {
      return void interaction.reply({ embeds: [errorEmbed('Only the ticket owner or staff can close this ticket.')], flags: 'Ephemeral' });
    }
    await interaction.reply({ embeds: [infoEmbed('🔒 Closing ticket', `Closed by <@${interaction.user.id}>. This channel is deleted in 5 seconds.`)] });
    setTimeout(() => void channel.delete(`Ticket closed by ${interaction.user.tag}`).catch(() => undefined), 5000);
    return;
  }

  if (!settings) return void interaction.reply({ embeds: [errorEmbed('Tickets aren\'t set up on this server anymore.')], flags: 'Ephemeral' });
  await interaction.deferReply({ flags: 'Ephemeral' });
  const guild = interaction.guild;
  const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && !!c.topic?.includes(`ticket-owner:${interaction.user.id}`));
  if (existing) return void interaction.editReply({ content: `You already have an open ticket: <#${existing.id}>` });

  const category = settings.categoryId ? guild.channels.cache.get(settings.categoryId) : undefined;
  const staff = settings.staffRoleIds.filter((id) => guild.roles.cache.has(id));
  const userPerms = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks;
  const counter = (settings.counter ?? 0) + 1;
  updateGuild(guild.id, (g) => {
    if (g.tickets) g.tickets.counter = counter;
  });
  try {
    const channel = await guild.channels.create({
      name: `ticket-${String(counter).padStart(4, '0')}-${interaction.user.username}`.slice(0, 100),
      type: ChannelType.GuildText,
      parent: category?.type === ChannelType.GuildCategory ? category.id : undefined,
      topic: `Support ticket for ${interaction.user.tag} | ticket-owner:${interaction.user.id}`,
      permissionOverwrites: [
        { id: guild.id, type: OverwriteType.Role, deny: PermissionFlagsBits.ViewChannel },
        { id: interaction.user.id, type: OverwriteType.Member, allow: userPerms },
        { id: guild.members.me!.id, type: OverwriteType.Member, allow: userPerms | PermissionFlagsBits.ManageChannels },
        ...staff.map((id) => ({ id, type: OverwriteType.Role, allow: userPerms | PermissionFlagsBits.ManageMessages })),
      ],
    });
    const close = new ButtonBuilder().setCustomId('gs:ticket:close').setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger);
    await channel.send({
      content: [`<@${interaction.user.id}>`, ...staff.map((id) => `<@&${id}>`)].join(' '),
      embeds: [infoEmbed('🎫 Ticket opened', 'Thanks for reaching out! Describe your issue and the staff team will be with you soon.')],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(close)],
      allowedMentions: { users: [interaction.user.id], roles: staff },
    });
    await interaction.editReply({ content: `🎫 Your ticket is ready: <#${channel.id}>` });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(explainError(err))] });
  }
}
