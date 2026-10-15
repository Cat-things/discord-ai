import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, EmbedBuilder, Guild, GuildMember, RepliableInteraction } from 'discord.js';
import { AIError } from '../ai/client';
import { makePlan, Plan, PlanMode } from '../ai/planner';
import { log } from '../logger';
import { addHistory, getGuild } from '../storage/db';
import { Action, orderActions } from './actions';
import { describeAction, executePlan, isActionDestructive, plannedNames } from './executor';
import { COLORS, errorEmbed, fitLines, infoEmbed, LiveReply, linkRows, progressBar, resultEmbeds, truncate } from './ui';

interface PendingPlan {
  guildId: string;
  userId: string;
  prompt: string;
  plan: Plan;
  ordered: Action[];
  createdAt: number;
}

const pending = new Map<string, PendingPlan>();
const busyGuilds = new Set<string>();
const PENDING_TTL = 30 * 60_000;

setInterval(() => {
  for (const [id, p] of pending) if (Date.now() - p.createdAt > PENDING_TTL) pending.delete(id);
}, 60_000).unref();

export interface AiRequest {
  mode: PlanMode;
  prompt: string;
  focus?: string;
  title?: string;
}

/** Full flow for /ask, /modify and the menu: plan with AI → maybe ask approval → execute → report. Interaction must be deferred. */
export async function runAiRequest(interaction: RepliableInteraction, req: AiRequest): Promise<void> {
  const guild = interaction.guild!;
  const member = interaction.member as GuildMember;
  const live = new LiveReply(interaction);
  if (busyGuilds.has(guild.id)) {
    await live.send({ embeds: [infoEmbed('⏳ Hold up', 'I\'m already building something on this server. Wait for it to finish first.', COLORS.warn)] });
    return;
  }

  const title = req.title ?? (req.mode === 'modify' ? '✏️ Modify' : '🏗️ Build');
  const thinking = (status: string) =>
    infoEmbed(`${title} — thinking…`, `> ${truncate(req.prompt, 300)}\n\n${status}`).setFooter({ text: 'Big servers + slow models can take a minute.' });

  busyGuilds.add(guild.id);
  let plan: Plan;
  try {
    await live.send({ embeds: [thinking('🧠 Reading your server and planning changes...')], components: [] });
    plan = await makePlan(guild, req, (status) => live.soft({ embeds: [thinking(status)] }));
  } catch (err) {
    busyGuilds.delete(guild.id);
    log.warn('[build] planning failed', err);
    const msg = err instanceof Error ? err.message : String(err);
    const hint = err instanceof AIError && err.code === 'auth' ? '\n\nFix it with `/provider set`.' : '';
    await live.send({ embeds: [errorEmbed(`${msg}${hint}`)], components: [] });
    return;
  }

  const ordered = orderActions(plan.actions);
  const footer = `${plan.providerName} · ${plan.model}`;
  const invalidNote = plan.invalid.length ? `\n\n*${plan.invalid.length} step(s) the AI wrote were invalid and dropped.*` : '';

  if (!ordered.length) {
    busyGuilds.delete(guild.id);
    await live.send({
      embeds: [infoEmbed(`${title} — answer`, `${truncate(plan.reply || 'Nothing to change.', 3500)}${invalidNote}`).setFooter({ text: footer })],
      components: [],
    });
    return;
  }

  const planned = plannedNames(guild, ordered);
  const destructive = ordered.filter((a) => isActionDestructive(a, planned));
  const autoMode = !!getGuild(guild.id).autoMode?.enabled;

  if (destructive.length && !autoMode) {
    busyGuilds.delete(guild.id);
    const id = crypto.randomBytes(6).toString('hex');
    pending.set(id, { guildId: guild.id, userId: interaction.user.id, prompt: req.prompt, plan, ordered, createdAt: Date.now() });
    const lines = ordered.map((a) => `${isActionDestructive(a, planned) ? '⚠️' : '▫️'} ${describeAction(a)}`);
    const embed = new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle(`${title} — needs your OK`)
      .setDescription(
        truncate(
          `${truncate(plan.reply, 900)}\n\n**${ordered.length} steps** · ⚠️ **${destructive.length} destructive** (they change or delete existing stuff)\n\n${fitLines(lines, 2600)}${invalidNote}\n\n*Tip: \`/auto enabled:true\` skips this check.*`,
          4096,
        ),
      )
      .setFooter({ text: footer });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`gs:plan:all:${id}`).setLabel('Run everything').setEmoji('✅').setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`gs:plan:safe:${id}`)
        .setLabel('Only safe steps')
        .setEmoji('🛡️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(destructive.length === ordered.length),
      new ButtonBuilder().setCustomId(`gs:plan:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    await live.send({ embeds: [embed], components: [row] });
    return;
  }

  try {
    await execute(live, guild, member, req.prompt, plan, ordered, true, title);
  } finally {
    busyGuilds.delete(guild.id);
  }
}

async function execute(live: LiveReply, guild: Guild, actor: GuildMember, prompt: string, plan: Plan, ordered: Action[], allowDestructive: boolean, title: string) {
  const footer = `${plan.providerName} · ${plan.model}`;
  const recent: string[] = [];
  await live.send({ embeds: [infoEmbed(`${title} — building…`, progressBar(0, ordered.length))], components: [] });

  const result = await executePlan({
    guild,
    actor,
    actions: ordered,
    allowDestructive,
    onProgress: (done, total, line) => {
      recent.push(`${line.status === 'ok' ? '✅' : line.status === 'skipped' ? '⏭️' : '❌'} ${line.text}`);
      live.soft({ embeds: [infoEmbed(`${title} — building…`, `${progressBar(done, total)}\n\n${fitLines(recent.slice(-12), 3000)}`)] });
    },
  });

  addHistory(guild.id, {
    at: new Date().toISOString(),
    by: actor.id,
    prompt,
    summary: plan.summary || plan.reply.slice(0, 300),
    created: result.created,
    changed: result.changed,
  });

  await live.send({ embeds: resultEmbeds(`${title} — done`, plan.reply, result, footer), components: linkRows(result.links) });
}

/** Handles the Run everything / Only safe steps / Cancel buttons on a plan preview. */
export async function handlePlanButton(interaction: ButtonInteraction<'cached'>): Promise<void> {
  const [, , choice, id] = interaction.customId.split(':');
  const entry = pending.get(id);
  if (!entry) {
    await interaction.update({ embeds: [errorEmbed('This plan expired. Run the command again.')], components: [] });
    return;
  }
  if (entry.userId !== interaction.user.id) {
    await interaction.reply({ embeds: [errorEmbed('Only the admin who asked can approve this plan.')], flags: 'Ephemeral' });
    return;
  }
  pending.delete(id);
  if (choice === 'cancel') {
    await interaction.update({ embeds: [infoEmbed('✖ Cancelled', 'Nothing was changed.')], components: [] });
    return;
  }
  if (busyGuilds.has(entry.guildId)) {
    pending.set(id, entry);
    await interaction.reply({ embeds: [errorEmbed('Another build is running on this server. Try again when it finishes.')], flags: 'Ephemeral' });
    return;
  }
  await interaction.deferUpdate();
  busyGuilds.add(entry.guildId);
  try {
    await execute(new LiveReply(interaction), interaction.guild, interaction.member, entry.prompt, entry.plan, entry.ordered, choice === 'all', '🏗️ Build');
  } finally {
    busyGuilds.delete(entry.guildId);
  }
}
