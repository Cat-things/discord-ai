import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-ui-'));

const json = (x: any) => (typeof x?.toJSON === 'function' ? x.toJSON() : x);

function fakeInteraction(extra: Record<string, unknown> = {}) {
  const calls: Record<string, any[]> = { reply: [], update: [], showModal: [], editReply: [] };
  const record = (name: string) => async (payload: any) => {
    calls[name].push(payload);
  };
  return {
    calls,
    interaction: {
      guildId: '111111111111111111',
      user: { id: '1' },
      options: { getString: () => null, getSubcommand: () => 'set' },
      reply: record('reply'),
      update: record('update'),
      showModal: record('showModal'),
      editReply: record('editReply'),
      deferReply: async () => undefined,
      ...extra,
    } as any,
  };
}

test('slash command definitions are valid for Discord', async () => {
  const { commandDefinitions } = await import('../commands/definitions');
  const body = commandDefinitions.map((c) => c.toJSON());
  assert.deepEqual(body.map((c) => c.name), ['provider', 'ask', 'modify', 'auto', 'help', 'Move message']);
  assert.equal((body[5] as any).type, 3, 'Move message is a message context menu');
  const provider = body[0] as any;
  const set = provider.options.find((o: any) => o.name === 'set');
  assert.equal(set.options[0].choices.length, 12, 'all 12 providers selectable');
  assert.ok(JSON.stringify(body).length < 8000);
});

test('/ask menu, every feature modal, templates and bots panel build valid components', async () => {
  const { askCommand, menuSelect, botsButton, FEATURES } = await import('../commands/ask');

  const menu = fakeInteraction();
  await askCommand(menu.interaction);
  const reply = menu.calls.reply[0];
  const select = json(reply.components[0]).components[0];
  assert.equal(select.options.length, FEATURES.length);
  assert.ok(FEATURES.length <= 25);

  for (const feature of FEATURES) {
    const f = fakeInteraction({ values: [feature.id], customId: 'gs:menu' });
    await menuSelect(f.interaction);
    if (feature.id === 'templates' || feature.id === 'bots') {
      const payload = f.calls.update[0];
      assert.ok(payload, `${feature.id} updates the panel`);
      payload.components.forEach((c: any) => json(c));
      if (feature.id === 'bots') assert.equal(json(payload.components[0]).components[0].options.length, 19);
    } else {
      const modal = json(f.calls.showModal[0]);
      assert.ok(modal.title.length <= 45, `${feature.id} modal title fits`);
      assert.ok(modal.components.length >= 1);
    }
  }

  const template = fakeInteraction({ values: ['gaming'], customId: 'gs:template' });
  await menuSelect(template.interaction);
  const modal = json(template.calls.showModal[0]);
  assert.match(JSON.stringify(modal), /gaming community/i);

  for (const customId of ['gs:bots:custom', 'gs:bots:ai']) {
    const b = fakeInteraction({ customId });
    await botsButton(b.interaction);
    json(b.calls.showModal[0]);
  }
});

test('/provider set shows a valid API key modal for every keyed provider', async () => {
  const { providerCommand } = await import('../commands/provider');
  const { PROVIDERS } = await import('../ai/providers');
  for (const info of PROVIDERS.values()) {
    if (!info.needsKey) continue;
    const p = fakeInteraction({
      options: { getSubcommand: () => 'set', getString: (name: string) => (name === 'provider' ? info.id : null) },
    });
    await providerCommand(p.interaction);
    const modal = json(p.calls.showModal[0]);
    assert.ok(modal.title.length <= 45, `${info.id} title`);
    assert.equal(modal.custom_id, `gs:provmodal:${info.id}`);
  }
});

test('result embeds and link rows stay inside Discord limits', async () => {
  const { resultEmbeds, linkRows } = await import('../discord/ui');
  const lines = Array.from({ length: 300 }, (_, i) => ({ status: 'ok' as const, text: `Created channel number ${i} with a fairly long name` }));
  const links = Array.from({ length: 30 }, (_, i) => ({ label: `Bot ${i}`, url: `https://discord.com/oauth2/authorize?client_id=${i}` }));
  const embeds = resultEmbeds('Done', 'x'.repeat(5000), { lines, created: [], changed: [], links, warnings: ['w'.repeat(5000)] }, 'footer');
  for (const e of embeds) assert.ok((e.data.description ?? '').length <= 4096);
  const rows = linkRows(links);
  assert.equal(rows.length, 5);
  rows.forEach((r) => json(r));
});

test('"Move message" right-click shows valid move/copy channel pickers', async () => {
  const { moveContextMenu } = await import('../commands/move');
  const m = fakeInteraction({
    client: { user: { id: 'bot' } },
    targetMessage: {
      id: '333333333333333333',
      channelId: '222222222222222222',
      system: false,
      content: 'hello there',
      embeds: [],
      components: [],
      author: { id: 'user', username: 'alice' },
    },
  });
  await moveContextMenu(m.interaction);
  const payload = m.calls.reply[0];
  const rows = payload.components.map((c: any) => json(c));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].components[0].custom_id, 'gs:move:m:222222222222222222:333333333333333333');
  assert.equal(rows[1].components[0].custom_id, 'gs:move:c:222222222222222222:333333333333333333');
  assert.ok(rows[0].components[0].channel_types.length >= 3);
});
