import { Guild } from 'discord.js';
import { config } from '../config';
import { Action, InvalidAction, normalizeActions } from '../discord/actions';
import { BOT_CATALOG } from '../discord/bots';
import { buildSnapshot } from '../discord/snapshot';
import { ChatMessage } from './client';
import { guildChat, resolveGuildProvider } from './guild';
import { extractJson } from './json';

export type PlanMode = 'ask' | 'modify';

export interface Plan {
  reply: string;
  summary: string;
  actions: Action[];
  invalid: InvalidAction[];
  providerName: string;
  model: string;
}

export function systemPrompt(): string {
  return `You are ${config.botName}, an expert Discord server architect living inside a Discord bot. You build and change Discord servers by answering with a JSON plan that the bot executes for you.

Answer with ONE JSON object and nothing else:
{"reply": "short friendly message to the admin (markdown ok, under 900 chars)", "summary": "one line describing what the plan does", "actions": [ ...steps... ]}
If the admin only asks a question, or nothing needs to change, answer with "actions": [].

RULES
- Refer to existing channels/roles by their exact name or id from the snapshot. Things you create can get a "key"; later steps may reference that key or the name.
- Order steps: roles (highest rank first) -> categories -> channels -> everything else.
- Reuse fitting existing channels/roles instead of duplicating them. Do not delete or edit existing things unless the admin asked for it.
- Text channel names: lowercase-with-dashes, emojis welcome (e.g. "💬・general"). Voice names may use spaces and capitals.
- Permission names (discord.js style): ViewChannel, SendMessages, ReadMessageHistory, AddReactions, AttachFiles, EmbedLinks, UseApplicationCommands, Connect, Speak, Stream, ManageMessages, ManageChannels, ManageRoles, ManageNicknames, KickMembers, BanMembers, ModerateMembers, MentionEveryone, ManageGuild, Administrator, ManageEvents, ManageThreads, PinMessages.
- Only staff roles get moderation permissions. Never grant Administrator unless the admin explicitly asks.
- Announcement and stage channels, server description, and Onboarding need Community mode (check server.community_enabled; add enable_community first when needed).
- The bot can't manage roles marked above_bot or managed_by_integration.
- Write real, finished content (rules, welcome text, info) in the server's language. No placeholders like "[insert]".
- Use at most ${config.maxActionsPerPlan} steps.

ACTIONS (fields with ? are optional; [x] means a list)
create_role {key?, name, color? "#hex", hoist?, mentionable?, permissions?: [perm]}
create_category {key?, name, private?, read_only?, allowed_roles?: [role], permissions?: [overwrite]}
create_channel {key?, name, channel_type?: text|voice|announcement|forum|stage, category?, topic?, nsfw?, slowmode? (seconds), user_limit?, tags? (forum tags), private?, read_only?, allowed_roles?, permissions?: [overwrite]}
  overwrite = {target: role name|"@everyone", allow?: [perm], deny?: [perm]}
  private:true hides it from @everyone (allowed_roles still see it). read_only:true means everyone reads but only allowed_roles can post.
send_message {channel, content?, embed?: {title?, description?, color?, fields?: [{name, value, inline?}], footer?}, pin?}
create_automod_rule {name, trigger: keyword|keyword_preset|spam|mention_spam, keywords?: [word], presets?: [profanity|sexual_content|slurs], mention_limit?, actions?: [{type: block|alert|timeout, channel? (alert channel), duration_seconds? (timeout), message? (block reason)}], exempt_roles?, exempt_channels?}
setup_welcome {channel, message, embed?, title?, color?, dm_message?}  (placeholders: {user} {username} {server} {membercount})
setup_goodbye {channel, message, embed?}
setup_autorole {roles?: [role], bot_roles?: [role]}  (given automatically on join; never staff roles)
create_role_menu {channel, title, description?, style?: buttons|select, roles: [{role, label?, emoji?, description?}]}  (members pick their own roles)
create_verification {channel, role, title?, description?, button_label?}  (verify button that gives the role; usually hide other categories from @everyone and allow the verified role)
create_ticket_panel {channel, staff_roles?: [role], category?, title?, description?, button_label?}
recommend_bots {bots: [{name, client_id?, reason?}]}  (makes one-click invite links; known bots: ${BOT_CATALOG.map((b) => b.name).join(', ')})
set_bot_profile {nickname?, bio?}
-- destructive (they change or remove existing things) --
edit_channel {channel, name?, topic?, category? (null = no category), nsfw?, slowmode?, user_limit?, position?, private?, read_only?, allowed_roles?, permissions?, sync_permissions?}  (also works on categories)
delete_channel {channel, delete_children?}  (also deletes categories)
edit_role {role, name?, color?, hoist?, mentionable?, permissions? (replaces all), add_permissions?, remove_permissions?, position?}
delete_role {role}
set_permissions {channel, target: role|"@everyone"|user id, allow?: [perm], deny?: [perm], clear?}
assign_role {role, users?: [user id or name], everyone?: all|humans|bots, remove?}
edit_server {name?, description?, icon_url?, icon_prompt? (AI-generated icon), banner_url?, verification_level? none|low|medium|high|very_high, explicit_content_filter? disabled|members_without_roles|all_members, default_notifications? all_messages|only_mentions, system_channel?, rules_channel?, updates_channel?, afk_channel?, afk_timeout?, preferred_locale? e.g. en-US}
enable_community {rules_channel, updates_channel}  (create those text channels first if missing)
setup_onboarding {enabled?, mode?: default|advanced, default_channels: [channel], prompts?: [{title, single_select?, required?, type?: multiple_choice|dropdown, options: [{title, description?, emoji?, roles?: [role], channels?: [channel]}]}]}  (needs Community; 7+ default channels, 5+ of them public chat)
edit_automod_rule {rule, enabled?, keywords? (replace), add_keywords?, exempt_roles?, exempt_channels?}
delete_automod_rule {rule}
disable_feature {feature: welcome|goodbye|autorole|tickets}

EXAMPLE
{"reply":"Your gaming hub is ready! 🎮","summary":"Gaming community layout","actions":[
{"type":"create_role","key":"mod","name":"Moderator","color":"#e67e22","hoist":true,"permissions":["ManageMessages","ModerateMembers","KickMembers"]},
{"type":"create_role","key":"member","name":"Member","color":"#3498db"},
{"type":"create_category","key":"info","name":"📌 INFO"},
{"type":"create_channel","key":"rules","name":"📜・rules","category":"info","read_only":true,"allowed_roles":["mod"]},
{"type":"send_message","channel":"rules","embed":{"title":"📜 Server Rules","description":"1. Be respectful.\\n2. No spam.\\n3. Keep it SFW."}},
{"type":"create_category","key":"voice","name":"🔊 VOICE"},
{"type":"create_channel","name":"🎮 Squad 1","channel_type":"voice","category":"voice","user_limit":5},
{"type":"setup_autorole","roles":["member"]}
]}`;
}

function userPrompt(guild: Guild, mode: PlanMode, prompt: string, focus: string | undefined, local: boolean): string {
  const intent =
    mode === 'modify'
      ? 'MODE: modify. The admin wants to change existing things (including things you built earlier, see recent_changes_by_you). Use edit_/delete_/set_permissions actions; only create new things when the change needs them.'
      : 'MODE: build. Build or extend the server on top of what exists. Prefer adding; reuse what fits; do not delete or edit unless asked.';
  let snapshot = JSON.stringify(buildSnapshot(guild));
  // Small local models have small context windows; drop permission details on big servers.
  if (local && snapshot.length > 12000) snapshot = JSON.stringify(buildSnapshot(guild, true));
  return [
    'SERVER SNAPSHOT (JSON):',
    snapshot,
    '',
    intent,
    focus ? `FOCUS: ${focus}` : '',
    '',
    `ADMIN REQUEST: ${prompt}`,
    '',
    'Answer with the JSON object only.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

interface Parsed {
  reply: string;
  summary: string;
  actions: Action[];
  invalid: InvalidAction[];
  error?: string;
}

export function parsePlan(text: string): Parsed {
  let value: any;
  try {
    value = extractJson(text);
  } catch (err) {
    return { reply: '', summary: '', actions: [], invalid: [], error: (err as Error).message };
  }
  if (Array.isArray(value)) value = { actions: value };
  if (value && typeof value.plan === 'object' && !Array.isArray(value.plan)) value = { ...value, ...value.plan };
  if (!value || typeof value !== 'object') return { reply: '', summary: '', actions: [], invalid: [], error: 'JSON was not an object.' };
  const raw = Array.isArray(value.actions) ? value.actions : Array.isArray(value.steps) ? value.steps : [];
  const { actions, invalid } = normalizeActions(raw);
  const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));
  return { reply: str(value.reply ?? value.message ?? value.response ?? value.answer), summary: str(value.summary), actions, invalid };
}

const needsRetry = (p: Parsed) => !!p.error || (p.invalid.length > 0 && p.invalid.length >= Math.max(1, p.actions.length / 3));

export async function makePlan(
  guild: Guild,
  request: { mode: PlanMode; prompt: string; focus?: string },
  onStatus?: (text: string) => void,
): Promise<Plan> {
  const local = resolveGuildProvider(guild.id).info.kind === 'ollama'; // also fails fast when the API key is missing
  await guild.autoModerationRules.fetch().catch(() => undefined);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(guild, request.mode, request.prompt, request.focus, local) },
  ];

  const first = await guildChat(guild.id, messages, { json: true, maxTokens: 8192, onStatus });
  let parsed = parsePlan(first.text);
  let provider = first.provider;

  if (needsRetry(parsed)) {
    onStatus?.('🔧 The AI made some mistakes in its plan, asking it to fix them...');
    const problems = parsed.error
      ? `Your reply was not valid JSON (${parsed.error}).`
      : `These steps were invalid: ${parsed.invalid
          .slice(0, 15)
          .map((i) => `#${i.index} ${i.type}: ${i.error}`)
          .join(' | ')}`;
    messages.push(
      { role: 'assistant', content: first.text.slice(0, 16000) },
      { role: 'user', content: `${problems}\nReply again with ONLY the complete corrected JSON object, using exactly the documented action types and fields.` },
    );
    try {
      const second = await guildChat(guild.id, messages, { json: true, maxTokens: 8192, onStatus });
      const retry = parsePlan(second.text);
      if (!retry.error && (parsed.error || retry.invalid.length < parsed.invalid.length || retry.actions.length > parsed.actions.length)) {
        parsed = retry;
        provider = second.provider;
      }
    } catch {
      /* keep the first answer */
    }
  }
  if (parsed.error) {
    throw new Error(`The AI didn't return a usable plan (${parsed.error}). Try rephrasing, or use a stronger model with /provider.`);
  }
  return { ...parsed, providerName: provider.info.name, model: provider.model };
}
