import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelSelectMenuInteraction,
  ChannelType,
  GuildTextBasedChannel,
  Message,
  MessageContextMenuCommandInteraction,
} from 'discord.js';
import { Refused } from '../discord/errors';
import { explainError } from '../discord/executor';
import { isMessageTarget, kindOfMessage, moveMessage, titleOf } from '../discord/messages';
import { COLORS, errorEmbed, infoEmbed, truncate } from '../discord/ui';

const TARGET_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice] as const;

/**
 * Messages someone right-clicked. Discord includes their content in that interaction even when the
 * Message Content intent is off, so moving them works without it (a fresh fetch would come back empty).
 */
const picked = new Map<string, { msg: Message; at: number }>();
const PICK_TTL = 15 * 60_000;

const kindLabel: Record<string, string> = { verification: 'verification panel', tickets: 'ticket panel', role_menu: 'role menu' };

/** Right-click a message → Apps → "Move message": pick where it should go. */
export async function moveContextMenu(interaction: MessageContextMenuCommandInteraction<'cached'>): Promise<void> {
  const msg = interaction.targetMessage;
  if (msg.system) {
    await interaction.reply({ embeds: [errorEmbed('System messages (joins, pins, boosts...) can\'t be moved.')], flags: 'Ephemeral' });
    return;
  }
  for (const [id, entry] of picked) if (Date.now() - entry.at > PICK_TTL) picked.delete(id);
  picked.set(msg.id, { msg, at: Date.now() });
  const kind = msg.author.id === interaction.client.user.id ? kindOfMessage(msg) : undefined;
  const label = kind ? kindLabel[kind] : undefined;
  const select = (mode: 'm' | 'c', placeholder: string) =>
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`gs:move:${mode}:${msg.channelId}:${msg.id}`)
        .setPlaceholder(placeholder)
        .setChannelTypes(...TARGET_TYPES),
    );
  const what = label ? `my **${label}** (its buttons keep working after the move)` : `**${msg.author.username}**'s message`;
  await interaction.reply({
    embeds: [
      infoEmbed(
        '📦 Move message',
        `Moving ${what}:\n> ${truncate(titleOf(msg).replace(/\n/g, ' '), 200)}\n\nDiscord can't move messages natively, so I repost it in the new channel${kind ? '' : ' with the author\'s name and avatar'} and delete the original.`,
      ),
    ],
    components: [select('m', '📦 Move it to…'), select('c', '📄 Copy it to… (keeps the original)')],
    flags: 'Ephemeral',
  });
}

export async function moveSelect(interaction: ChannelSelectMenuInteraction<'cached'>): Promise<void> {
  const [, , mode, channelId, messageId] = interaction.customId.split(':');
  await interaction.deferUpdate();
  try {
    let msg = picked.get(messageId)?.msg;
    if (!msg) {
      const source = interaction.guild.channels.cache.get(channelId) ?? (await interaction.guild.channels.fetch(channelId).catch(() => null));
      if (!source?.isTextBased()) throw new Refused('The original channel is gone.');
      msg = await (source as GuildTextBasedChannel).messages.fetch(messageId).catch(() => undefined);
    }
    if (!msg) throw new Refused('The original message is gone.');
    const choice = interaction.channels.first();
    const target = choice && 'guildId' in choice ? interaction.guild.channels.cache.get(choice.id) : undefined;
    if (!isMessageTarget(target)) throw new Refused('Pick a text, announcement or voice channel.');
    const result = await moveMessage(interaction.guild, msg, target, { keepOriginal: mode === 'c' });
    if (result.deletedOriginal) picked.delete(messageId);
    await interaction.editReply({
      embeds: [
        infoEmbed(
          mode === 'c' ? '📄 Copied' : '📦 Moved',
          `Done → <#${target.id}> · [jump to it](${result.moved.url})${result.note ? `\n\n⚠️ ${result.note}` : ''}`,
          COLORS.ok,
        ),
      ],
      components: [],
    });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(explainError(err))], components: [] });
  }
}
