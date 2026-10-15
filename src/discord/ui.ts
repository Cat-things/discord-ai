import {
  ActionRowBuilder,
  BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionEditReplyOptions,
  Message,
  RepliableInteraction,
} from 'discord.js';
import { log } from '../logger';
import { BotLink, BRAND_COLOR, ExecResult, ResultLine } from './executor';

export const COLORS = { brand: BRAND_COLOR, ok: 0x57f287, warn: 0xfee75c, error: 0xed4245 } as const;

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function infoEmbed(title: string, description: string, color: number = COLORS.brand): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setTitle(truncate(title, 256)).setDescription(truncate(description || '​', 4096));
}

export function errorEmbed(description: string): EmbedBuilder {
  return infoEmbed('❌ Something went wrong', description, COLORS.error);
}

/** Joins lines into a block that fits Discord's limit, noting how many were cut. */
export function fitLines(lines: string[], max = 3800): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, line] of lines.entries()) {
    if (used + line.length + 1 > max) {
      out.push(`*…and ${lines.length - i} more*`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

export function progressBar(done: number, total: number, width = 16): string {
  const filled = total ? Math.round((done / total) * width) : width;
  return `\`${'█'.repeat(filled)}${'░'.repeat(width - filled)}\` ${done}/${total}`;
}

const icon = (l: ResultLine) => (l.status === 'ok' ? '✅' : l.status === 'skipped' ? '⏭️' : '❌');

export function resultEmbeds(title: string, aiReply: string, result: ExecResult, footer: string): EmbedBuilder[] {
  const ok = result.lines.filter((l) => l.status === 'ok').length;
  const failed = result.lines.filter((l) => l.status === 'failed').length;
  const skipped = result.lines.filter((l) => l.status === 'skipped').length;
  const color = failed ? (ok ? COLORS.warn : COLORS.error) : COLORS.ok;
  const head = [aiReply ? truncate(aiReply, 1000) : '', `**${ok} done** · ${failed} failed · ${skipped} skipped`].filter(Boolean).join('\n\n');
  const embeds = [
    new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(truncate(`${head}\n\n${fitLines(result.lines.map((l) => `${icon(l)} ${l.text}`), 2800)}`, 4096))
      .setFooter({ text: truncate(footer, 2048) }),
  ];
  if (result.warnings.length) {
    embeds.push(infoEmbed('⚠️ Heads up', fitLines([...new Set(result.warnings)].map((w) => `• ${w}`), 3500), COLORS.warn));
  }
  if (result.links.length) {
    embeds.push(
      infoEmbed(
        '🤖 Add these bots',
        fitLines(
          [
            'Discord makes a human click **Authorize** for every bot (anti-spam rule, no bot can skip it). Your server is already pre-selected, so it\'s one click each:',
            '',
            ...result.links.map((l) => `• **${l.label}**${l.note ? ` — ${l.note}` : ''}`),
          ],
          3500,
        ),
      ),
    );
  }
  return embeds;
}

/** Link buttons for bot invites, 5 per row, max 5 rows. */
export function linkRows(links: BotLink[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  links.slice(0, 25).forEach((link, i) => {
    if (i % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>());
    rows[rows.length - 1].addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link.url).setLabel(truncate(`Add ${link.label}`, 80)));
  });
  return rows;
}

/**
 * Keeps one status message up to date. Slash command replies can only be edited for 15 minutes
 * (slow local models can take longer), so it falls back to a DM when the interaction expires.
 */
export class LiveReply {
  private dm: Message | null = null;
  private lastEdit = 0;
  private pending: NodeJS.Timeout | null = null;
  private latest: InteractionEditReplyOptions | null = null;

  constructor(private readonly interaction: RepliableInteraction) {}

  /** Throttled update for progress spam; the newest payload always wins. */
  soft(payload: InteractionEditReplyOptions): void {
    this.latest = payload;
    const wait = 1500 - (Date.now() - this.lastEdit);
    if (wait <= 0) {
      void this.flush();
    } else if (!this.pending) {
      this.pending = setTimeout(() => void this.flush(), wait);
    }
  }

  private async flush(): Promise<void> {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    const payload = this.latest;
    this.latest = null;
    if (payload) await this.send(payload);
  }

  /** Immediate update (final results, previews). */
  async send(payload: InteractionEditReplyOptions): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
      this.latest = null;
    }
    this.lastEdit = Date.now();
    if (!this.dm) {
      try {
        await this.interaction.editReply(payload);
        return;
      } catch (err) {
        log.debug('editReply failed, falling back to DM', err);
      }
    }
    try {
      const dmPayload = { content: payload.content ?? undefined, embeds: payload.embeds, components: payload.components } as BaseMessageOptions;
      if (this.dm) await this.dm.edit(dmPayload);
      else this.dm = await this.interaction.user.send(dmPayload);
    } catch (err) {
      log.warn('Could not deliver status update (interaction expired and DMs closed).', err);
    }
  }
}
