import { z } from 'zod';

/* Lenient building blocks: models often send numbers as strings, single values instead of lists, etc. */
const id = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const list = z
  .union([z.array(id), id])
  .transform((v) => (Array.isArray(v) ? v : [v]).filter((s) => s.length > 0));
const bool = z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' || v === '1' || v === 'yes' : v), z.boolean());
const num = z.coerce.number();
const text = z.union([z.string(), z.number()]).transform(String);
const color = z.union([z.string(), z.number()]);

const overwrite = z.object({
  target: id,
  allow: list.optional(),
  deny: list.optional(),
});

const permissionShortcuts = {
  /** Hide from @everyone; only allowed_roles (and the bot) can see it. */
  private: bool.optional(),
  /** @everyone can read but not talk; allowed_roles can still post. */
  read_only: bool.optional(),
  allowed_roles: list.optional(),
  permissions: z.array(overwrite).optional(),
};

const embed = z.object({
  title: text.optional(),
  description: text.optional(),
  color: color.optional(),
  fields: z.array(z.object({ name: text, value: text, inline: bool.optional() })).optional(),
  footer: text.optional(),
  image_url: z.string().optional(),
  thumbnail_url: z.string().optional(),
});

const key = { key: id.optional() };

export const actionSchemas = {
  create_role: z.object({
    ...key,
    name: text,
    color: color.optional(),
    hoist: bool.optional(),
    mentionable: bool.optional(),
    permissions: list.optional(),
  }),
  create_category: z.object({ ...key, name: text, ...permissionShortcuts }),
  create_channel: z.object({
    ...key,
    name: text,
    channel_type: z
      .string()
      .transform((t) => t.toLowerCase().replace(/[^a-z]/g, ''))
      .optional(),
    category: id.optional(),
    topic: text.optional(),
    nsfw: bool.optional(),
    slowmode: num.optional(),
    user_limit: num.optional(),
    tags: list.optional(),
    ...permissionShortcuts,
  }),
  send_message: z.object({
    channel: id,
    content: text.optional(),
    embed: embed.optional(),
    /** Link buttons under the message (https only, max 5). */
    buttons: z.array(z.object({ label: text, url: z.string() })).optional(),
    /** "everyone", "here" or a role. Pinging always needs approval. */
    ping: z.string().optional(),
    pin: bool.optional(),
  }),
  create_automod_rule: z.object({
    name: text,
    trigger: z.string().transform((t) => t.toLowerCase().replace(/[^a-z]/g, '')),
    keywords: list.optional(),
    regex: list.optional(),
    allow_list: list.optional(),
    presets: list.optional(),
    mention_limit: num.optional(),
    raid_protection: bool.optional(),
    actions: z
      .array(
        z.object({
          type: z.string().transform((t) => t.toLowerCase()),
          channel: id.optional(),
          duration_seconds: num.optional(),
          message: text.optional(),
        }),
      )
      .optional(),
    exempt_roles: list.optional(),
    exempt_channels: list.optional(),
    enabled: bool.optional(),
  }),
  setup_welcome: z.object({
    channel: id,
    message: text,
    embed: bool.optional(),
    title: text.optional(),
    color: color.optional(),
    image_url: z.string().optional(),
    dm_message: text.optional(),
  }),
  setup_goodbye: z.object({ channel: id, message: text, embed: bool.optional() }),
  setup_autorole: z.object({ roles: list.optional(), bot_roles: list.optional() }),
  create_role_menu: z.object({
    channel: id,
    title: text,
    description: text.optional(),
    style: z.string().optional(),
    roles: z.array(
      z.union([
        id.transform((role) => ({ role, label: undefined, emoji: undefined, description: undefined })),
        z.object({ role: id, label: text.optional(), emoji: z.string().optional(), description: text.optional() }),
      ]),
    ),
  }),
  create_verification: z.object({
    channel: id,
    role: id,
    title: text.optional(),
    description: text.optional(),
    button_label: text.optional(),
  }),
  create_ticket_panel: z.object({
    channel: id,
    title: text.optional(),
    description: text.optional(),
    staff_roles: list.optional(),
    category: id.optional(),
    button_label: text.optional(),
  }),
  recommend_bots: z.object({
    bots: z.array(
      z.union([
        text.transform((name) => ({ name, client_id: undefined, reason: undefined })),
        z.object({ name: text, client_id: id.optional(), reason: text.optional() }),
      ]),
    ),
  }),
  set_bot_profile: z.object({ nickname: text.optional(), bio: text.optional() }),

  // ---- destructive: these change or remove things that already exist ----
  edit_channel: z.object({
    channel: id,
    name: text.optional(),
    topic: text.optional(),
    category: id.nullable().optional(),
    nsfw: bool.optional(),
    slowmode: num.optional(),
    user_limit: num.optional(),
    position: num.optional(),
    sync_permissions: bool.optional(),
    ...permissionShortcuts,
  }),
  delete_channel: z.object({ channel: id, delete_children: bool.optional() }),
  move_message: z.object({ message: id, to_channel: id, keep_original: bool.optional() }),
  move_messages: z.object({
    from_channel: id,
    to_channel: id,
    count: num.optional(),
    author: id.optional(),
    keep_original: bool.optional(),
  }),
  edit_message: z.object({ message: id, content: text.optional(), embed: embed.optional() }),
  delete_message: z.object({ message: id }),
  edit_role: z.object({
    role: id,
    name: text.optional(),
    color: color.optional(),
    hoist: bool.optional(),
    mentionable: bool.optional(),
    permissions: list.optional(),
    add_permissions: list.optional(),
    remove_permissions: list.optional(),
    position: num.optional(),
  }),
  delete_role: z.object({ role: id }),
  set_permissions: z.object({
    channel: id,
    target: id,
    allow: list.optional(),
    deny: list.optional(),
    clear: bool.optional(),
  }),
  assign_role: z.object({
    role: id,
    users: list.optional(),
    everyone: z.string().optional(),
    remove: bool.optional(),
  }),
  edit_server: z.object({
    name: text.optional(),
    description: text.optional(),
    icon_url: z.string().optional(),
    icon_prompt: text.optional(),
    banner_url: z.string().optional(),
    verification_level: text.optional(),
    explicit_content_filter: text.optional(),
    default_notifications: text.optional(),
    system_channel: id.nullable().optional(),
    rules_channel: id.optional(),
    updates_channel: id.optional(),
    afk_channel: id.nullable().optional(),
    afk_timeout: num.optional(),
    preferred_locale: z.string().optional(),
  }),
  enable_community: z.object({ rules_channel: id, updates_channel: id }),
  setup_onboarding: z.object({
    enabled: bool.optional(),
    mode: z.string().optional(),
    default_channels: list.optional(),
    prompts: z
      .array(
        z.object({
          title: text,
          type: z.string().optional(),
          single_select: bool.optional(),
          required: bool.optional(),
          in_onboarding: bool.optional(),
          options: z.array(
            z.object({
              title: text,
              description: text.optional(),
              emoji: z.string().optional(),
              roles: list.optional(),
              channels: list.optional(),
            }),
          ),
        }),
      )
      .optional(),
  }),
  edit_automod_rule: z.object({
    rule: id,
    enabled: bool.optional(),
    keywords: list.optional(),
    add_keywords: list.optional(),
    exempt_roles: list.optional(),
    exempt_channels: list.optional(),
  }),
  delete_automod_rule: z.object({ rule: id }),
  disable_feature: z.object({ feature: z.string().transform((f) => f.toLowerCase()) }),
} as const;

export type ActionType = keyof typeof actionSchemas;
export type ActionOf<T extends ActionType> = z.infer<(typeof actionSchemas)[T]> & { type: T };
export type Action = { [T in ActionType]: ActionOf<T> }[ActionType];

/** Always need a confirmation (unless /auto is on) because they touch things that already exist. */
export const DESTRUCTIVE_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  'edit_channel',
  'delete_channel',
  'move_message',
  'move_messages',
  'edit_message',
  'delete_message',
  'edit_role',
  'delete_role',
  'set_permissions',
  'assign_role',
  'edit_server',
  'enable_community',
  'setup_onboarding',
  'edit_automod_rule',
  'delete_automod_rule',
  'disable_feature',
]);

/** Common names models invent for our actions. */
const typeAliases: Record<string, string> = {
  create_text_channel: 'create_channel',
  create_voice_channel: 'create_channel',
  create_forum_channel: 'create_channel',
  create_announcement_channel: 'create_channel',
  add_channel: 'create_channel',
  add_category: 'create_category',
  add_role: 'create_role',
  give_role: 'assign_role',
  remove_role: 'assign_role',
  rename_channel: 'edit_channel',
  update_channel: 'edit_channel',
  move_channel: 'edit_channel',
  edit_category: 'edit_channel',
  rename_category: 'edit_channel',
  delete_category: 'delete_channel',
  remove_channel: 'delete_channel',
  update_role: 'edit_role',
  rename_role: 'edit_role',
  remove_role_entirely: 'delete_role',
  post_message: 'send_message',
  message: 'send_message',
  send_embed: 'send_message',
  create_reaction_roles: 'create_role_menu',
  reaction_roles: 'create_role_menu',
  self_roles: 'create_role_menu',
  create_self_roles: 'create_role_menu',
  automod: 'create_automod_rule',
  create_automod: 'create_automod_rule',
  add_automod_rule: 'create_automod_rule',
  welcome: 'setup_welcome',
  set_welcome: 'setup_welcome',
  goodbye: 'setup_goodbye',
  autorole: 'setup_autorole',
  auto_role: 'setup_autorole',
  set_autorole: 'setup_autorole',
  verification: 'create_verification',
  setup_verification: 'create_verification',
  tickets: 'create_ticket_panel',
  setup_tickets: 'create_ticket_panel',
  community: 'enable_community',
  enable_community_mode: 'enable_community',
  onboarding: 'setup_onboarding',
  edit_onboarding: 'setup_onboarding',
  add_bots: 'recommend_bots',
  add_bot: 'recommend_bots',
  suggest_bots: 'recommend_bots',
  invite_bots: 'recommend_bots',
  update_server: 'edit_server',
  server_settings: 'edit_server',
  edit_guild: 'edit_server',
  set_server_profile: 'edit_server',
  edit_permissions: 'set_permissions',
  channel_permissions: 'set_permissions',
  set_nickname: 'set_bot_profile',
  move_panel: 'move_message',
  move_post: 'move_message',
  repost_message: 'move_message',
  copy_message: 'move_message',
  copy_messages: 'move_messages',
  move_chat: 'move_messages',
  move_history: 'move_messages',
  move_recent_messages: 'move_messages',
  move_conversation: 'move_messages',
  bulk_move_messages: 'move_messages',
  update_message: 'edit_message',
  edit_post: 'edit_message',
  remove_message: 'delete_message',
  delete_post: 'delete_message',
  announce: 'send_message',
  send_announcement: 'send_message',
  post_announcement: 'send_message',
};

export interface InvalidAction {
  index: number;
  type: string;
  error: string;
}

/** Turns whatever the model produced into validated actions, keeping per-action errors for feedback. */
export function normalizeActions(raw: unknown[]): { actions: Action[]; invalid: InvalidAction[] } {
  const actions: Action[] = [];
  const invalid: InvalidAction[] = [];

  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      invalid.push({ index, type: '?', error: 'not an object' });
      return;
    }
    let obj = { ...(item as Record<string, unknown>) };
    // Flatten {"type": "x", "params": {...}} style output.
    for (const nest of ['params', 'parameters', 'args', 'arguments', 'data', 'options']) {
      const inner = obj[nest];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        obj = { ...obj, ...(inner as Record<string, unknown>) };
        delete obj[nest];
      }
    }
    const norm = (v: unknown) => String(v ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    const known = (v: unknown) => Object.hasOwn(actionSchemas, norm(v)) || Object.hasOwn(typeAliases, norm(v));

    let type: string;
    let channelType: unknown = obj.channel_type ?? obj.kind;
    if (obj.action !== undefined && known(obj.action)) {
      type = norm(obj.action);
      if (obj.type !== undefined && !known(obj.type)) channelType ??= obj.type;
    } else {
      type = norm(obj.type ?? obj.action ?? obj.tool ?? obj.op);
    }
    const shorthand = /^create_(text|voice|forum|announcement|stage)_channel$/.exec(type);
    if (shorthand) channelType ??= shorthand[1];
    const removing = type === 'remove_role';
    const copying = type === 'copy_message' || type === 'copy_messages';
    if (Object.hasOwn(typeAliases, type)) type = typeAliases[type];
    if (type === 'create_channel' && norm(channelType) === 'category') type = 'create_category';

    const schema = Object.hasOwn(actionSchemas, type) ? actionSchemas[type as ActionType] : undefined;
    if (!schema) {
      invalid.push({ index, type: type || '?', error: `unknown action type "${type}"` });
      return;
    }
    const fields: Record<string, unknown> = { ...obj };
    for (const k of ['type', 'action', 'tool', 'op', 'kind']) delete fields[k];
    if (type === 'create_channel') fields.channel_type = channelType;
    if (removing) fields.remove = true;
    if (copying) fields.keep_original = true;

    const parsed = schema.safeParse(fields);
    if (!parsed.success) {
      invalid.push({
        index,
        type,
        error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      });
      return;
    }
    actions.push({ ...(parsed.data as object), type } as Action);
  });

  return { actions, invalid };
}

/** Execution order safety net, so "create channel in category X" works even if X comes later in the list. */
const phase: Record<ActionType, number> = {
  delete_channel: 0,
  delete_role: 0,
  delete_automod_rule: 0,
  disable_feature: 0,
  create_role: 1,
  edit_role: 1,
  create_category: 2,
  create_channel: 3,
  edit_channel: 4,
  set_permissions: 4,
  enable_community: 5,
  assign_role: 6,
  setup_welcome: 6,
  setup_goodbye: 6,
  setup_autorole: 6,
  send_message: 6,
  create_role_menu: 6,
  create_verification: 6,
  create_ticket_panel: 6,
  create_automod_rule: 6,
  edit_automod_rule: 6,
  edit_server: 7,
  set_bot_profile: 7,
  move_message: 7,
  move_messages: 7,
  edit_message: 7,
  delete_message: 7,
  setup_onboarding: 8,
  recommend_bots: 9,
};

export function orderActions(actions: Action[]): Action[] {
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => phase[x.a.type] - phase[y.a.type] || x.i - y.i)
    .map(({ a }) => a);
}
