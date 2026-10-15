import crypto from 'node:crypto';
import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  LabelBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { AIError, chat, listModels, pickModel, ResolvedProvider } from '../ai/client';
import { resolveGuildProvider } from '../ai/guild';
import { getProvider, ProviderInfo } from '../ai/providers';
import { ollamaQueue } from '../ai/queue';
import { config, envApiKey } from '../config';
import { COLORS, errorEmbed, infoEmbed, truncate } from '../discord/ui';
import { decrypt, encrypt, maskKey } from '../storage/crypto';
import { getGuild, updateGuild } from '../storage/db';

const modelCache = new Map<string, { at: number; models: string[] }>();

async function cachedModels(info: ProviderInfo, apiKey: string): Promise<string[]> {
  const cacheKey = `${info.id}:${crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}`;
  const hit = modelCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.models;
  const models = await Promise.race([listModels(info, apiKey), new Promise<string[]>((r) => setTimeout(() => r([]), 2200))]);
  if (models.length) modelCache.set(cacheKey, { at: Date.now(), models });
  return models;
}

function savedKey(guildId: string, providerId: string): string {
  const saved = getGuild(guildId).provider;
  if (saved?.id === providerId && saved.apiKey) return decrypt(saved.apiKey);
  return envApiKey(providerId);
}

export async function providerAutocomplete(interaction: AutocompleteInteraction<'cached'>): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  const sub = interaction.options.getSubcommand();
  const providerId = sub === 'set' ? interaction.options.getString('provider') : getGuild(interaction.guildId).provider?.id ?? config.defaultProvider;
  const info = providerId ? getProvider(providerId) : undefined;
  if (!info) return interaction.respond([]);

  const key = savedKey(interaction.guildId, info.id);
  const live = !info.needsKey || key ? await cachedModels(info, key) : [];
  const pool = [...new Set([...info.preferredModels, ...live])];
  const matches = pool.filter((m) => m.toLowerCase().includes(typed)).slice(0, 25);
  await interaction.respond(matches.map((m) => ({ name: truncate(m, 100), value: truncate(m, 100) })));
}

export async function providerCommand(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'set') return providerSet(interaction);
  if (sub === 'model') return providerModel(interaction);
  if (sub === 'status') return providerStatus(interaction);
  if (sub === 'test') return providerTest(interaction);
  if (sub === 'reset') {
    updateGuild(interaction.guildId, (g) => delete g.provider);
    await interaction.reply({
      embeds: [infoEmbed('🧹 Provider reset', `Back to the default: **${getProvider(config.defaultProvider)?.name ?? config.defaultProvider}**. The stored API key was deleted.`)],
      flags: 'Ephemeral',
    });
  }
}

async function providerSet(interaction: ChatInputCommandInteraction<'cached'>) {
  const info = getProvider(interaction.options.getString('provider', true))!;
  const model = interaction.options.getString('model') ?? '';

  if (!info.needsKey) {
    await interaction.deferReply({ flags: 'Ephemeral' });
    return saveAndVerify(interaction, info, '', model);
  }

  const hasKey = !!savedKey(interaction.guildId, info.id);
  const modal = new ModalBuilder()
    .setCustomId(`gs:provmodal:${info.id}`)
    .setTitle(truncate(`${info.name} setup`, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('API key')
        .setDescription(hasKey ? 'Leave empty to keep the key you already saved.' : `Get one at ${info.keyUrl}`.slice(0, 100))
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('key').setStyle(TextInputStyle.Short).setRequired(!hasKey).setPlaceholder('Paste your API key (stored encrypted)').setMaxLength(400),
        ),
      new LabelBuilder()
        .setLabel('Model (optional)')
        .setDescription('Empty = auto-pick the best available model.')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('model').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(info.defaultModel).setValue(model).setMaxLength(150),
        ),
    );
  await interaction.showModal(modal);
}

export async function providerModalSubmit(interaction: ModalSubmitInteraction<'cached'>): Promise<void> {
  const info = getProvider(interaction.customId.split(':')[2]);
  if (!info) return;
  await interaction.deferReply({ flags: 'Ephemeral' });
  const typedKey = interaction.fields.getTextInputValue('key').trim();
  const key = typedKey || savedKey(interaction.guildId, info.id);
  if (!key) {
    await interaction.editReply({ embeds: [errorEmbed(`${info.name} needs an API key. Get one at ${info.keyUrl}`)] });
    return;
  }
  await saveAndVerify(interaction, info, key, interaction.fields.getTextInputValue('model').trim());
}

async function saveAndVerify(interaction: ChatInputCommandInteraction<'cached'> | ModalSubmitInteraction<'cached'>, info: ProviderInfo, key: string, requestedModel: string) {
  await interaction.editReply({ embeds: [infoEmbed(`${info.emoji} Checking ${info.name}…`, 'Finding the best model and sending a tiny test prompt.')] });

  let model = requestedModel;
  let available: string[] = [];
  if (info.kind === 'ollama') {
    model ||= config.ollama.model;
    available = await listModels(info, key);
  } else if (!model) {
    ({ model, available } = await pickModel(info, key));
  }

  const provider: ResolvedProvider = { info, apiKey: key, model };
  let testNote: string;
  try {
    if (info.kind === 'ollama' && !available.includes(model) && !available.includes(`${model}:latest`)) {
      // Reachability check only; pulling a model here would block the command for minutes.
      const reachable = await fetch(`${config.ollama.url}/api/version`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false);
      if (!reachable) throw new AIError(`Ollama isn't running at ${config.ollama.url}. Install it from https://ollama.com/download and start it.`, 'unreachable');
      testNote = config.ollama.autoPull
        ? `⚠️ \`${model}\` isn't downloaded yet. I'll download it automatically the first time you use \`/ask\` (or run \`ollama pull ${model}\` on the bot's PC now).`
        : `⚠️ \`${model}\` isn't downloaded. Run \`ollama pull ${model}\` on the bot's PC.`;
    } else {
      const started = Date.now();
      const reply = await chat(provider, [{ role: 'user', content: 'Reply with just the word OK.' }], { maxTokens: 300 });
      testNote = `✅ Test passed in ${((Date.now() - started) / 1000).toFixed(1)}s (model said: "${truncate(reply.trim(), 40)}")`;
    }
  } catch (err) {
    if (err instanceof AIError && err.code === 'auth') {
      await interaction.editReply({ embeds: [errorEmbed(`${err.message}\n\nNothing was saved. Double-check the key at ${info.keyUrl}`)] });
      return;
    }
    if (err instanceof AIError && err.code === 'unreachable' && info.kind === 'ollama') {
      await interaction.editReply({ embeds: [errorEmbed(err.message)] });
      return;
    }
    testNote = `⚠️ Saved, but the test failed: ${truncate(err instanceof Error ? err.message : String(err), 500)}`;
  }

  updateGuild(interaction.guildId, (g) => {
    g.provider = {
      id: info.id,
      model,
      apiKey: key && key !== envApiKey(info.id) ? encrypt(key) : undefined,
      updatedBy: interaction.user.id,
      updatedAt: new Date().toISOString(),
    };
  });

  const lines = [
    `**Provider:** ${info.emoji} ${info.name}`,
    `**Model:** \`${model}\``,
    info.needsKey ? `**Key:** \`${maskKey(key)}\` (encrypted on the bot's disk)` : '**Key:** not needed 🎉',
    '',
    testNote,
    info.note ? `\nℹ️ ${info.note}` : '',
    available.length ? `\n*${available.length} models available. Switch anytime with \`/provider model\`.*` : '',
  ];
  await interaction.editReply({ embeds: [infoEmbed('✅ AI provider saved', lines.filter((l) => l !== undefined).join('\n'), COLORS.ok)] });
}

async function providerModel(interaction: ChatInputCommandInteraction<'cached'>) {
  const model = interaction.options.getString('model', true).trim();
  const saved = getGuild(interaction.guildId).provider;
  const info = getProvider(saved?.id ?? config.defaultProvider)!;
  if (info.needsKey && !savedKey(interaction.guildId, info.id)) {
    await interaction.reply({ embeds: [errorEmbed(`Set up ${info.name} first with \`/provider set\`.`)], flags: 'Ephemeral' });
    return;
  }
  updateGuild(interaction.guildId, (g) => {
    g.provider = { ...(g.provider ?? { id: info.id }), id: info.id, model, updatedBy: interaction.user.id, updatedAt: new Date().toISOString() };
  });
  await interaction.reply({ embeds: [infoEmbed('✅ Model changed', `${info.emoji} ${info.name} now uses \`${model}\`. Run \`/provider test\` to check it.`, COLORS.ok)], flags: 'Ephemeral' });
}

async function providerStatus(interaction: ChatInputCommandInteraction<'cached'>) {
  const settings = getGuild(interaction.guildId);
  const info = getProvider(settings.provider?.id ?? config.defaultProvider)!;
  const key = savedKey(interaction.guildId, info.id);
  const model = (settings.provider?.id === info.id && settings.provider.model) || info.defaultModel;
  const lines = [
    `**Provider:** ${info.emoji} ${info.name}${settings.provider ? '' : ' *(default)*'}`,
    `**Model:** \`${model}\``,
    `**API key:** ${!info.needsKey ? 'not needed' : key ? `\`${maskKey(key)}\`${settings.provider?.apiKey ? '' : ' (from the bot owner\'s .env)'}` : '❌ missing, run `/provider set`'}`,
    `**Auto mode:** ${settings.autoMode?.enabled ? '🟢 ON (destructive actions run without asking)' : '⚪ off (I ask before destructive actions)'}`,
  ];
  if (info.kind === 'ollama') lines.push(`**Local queue:** ${ollamaQueue.queued} waiting · ${config.ollama.concurrency} at a time · ${config.ollama.url}`);
  await interaction.reply({ embeds: [infoEmbed('🔌 AI status', lines.join('\n'))], flags: 'Ephemeral' });
}

async function providerTest(interaction: ChatInputCommandInteraction<'cached'>) {
  await interaction.deferReply({ flags: 'Ephemeral' });
  try {
    const provider = resolveGuildProvider(interaction.guildId);
    const started = Date.now();
    const reply = await chat(provider, [{ role: 'user', content: 'Say hi to the Discord admin in under 15 words.' }], {
      maxTokens: 300,
      onStatus: (s) => void interaction.editReply({ embeds: [infoEmbed('🧪 Testing…', s)] }).catch(() => undefined),
    });
    await interaction.editReply({
      embeds: [
        infoEmbed(
          '🧪 Provider works',
          `${provider.info.emoji} **${provider.info.name}** · \`${provider.model}\` answered in **${((Date.now() - started) / 1000).toFixed(1)}s**:\n> ${truncate(reply.trim(), 300)}`,
          COLORS.ok,
        ),
      ],
    });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(err instanceof Error ? err.message : String(err))] });
  }
}
