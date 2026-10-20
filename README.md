# ⚒️ GuildSmith — AI Discord server builder

GuildSmith is a Discord bot that **builds and manages your server for you**. You tell it what you want in plain English and it creates the categories, channels, roles, permissions, welcome messages, AutoMod, Community mode, Onboarding and more.

- **12 AI providers:** Gemini, Grok (xAI), Groq, OpenAI, Anthropic, OpenRouter, fal, Qwen, DeepSeek, Mistral, Z.AI, plus **local Ollama** (free, no API key).
- **`/ask`** builds the server or adds on top of it. With no prompt it opens a **feature menu**.
- **`/modify`** changes existing stuff, including things the bot built earlier ("undo the last build", "move the ticket panel to #support").
- **Messages:** the AI posts messages and announcements while building or modifying (link buttons, pings only if you ask). It can also **move, copy, edit or delete** messages, including its verification, ticket and role-menu panels. Or right-click any message → **Apps → Move message**.
- **`/auto`** turns on auto mode, so destructive actions run without asking.
- **`/provider`** picks the AI. API keys are entered in a private pop-up and stored **encrypted**.

---

## Contents
1. [Features](#features)
2. [Create the bot on Discord](#1-create-the-bot-on-discord)
3. [Build & test on your Windows PC](#2-build--test-on-your-windows-pc)
4. [Run it 24/7 on your Debian server](#3-run-it-247-on-your-old-debian-server)
5. [Commands](#commands)
6. [AI providers](#ai-providers)
7. [Safety: what needs approval](#safety-what-needs-approval)
8. [About "adding bots automatically"](#about-adding-bots-automatically)
9. [Troubleshooting](#troubleshooting)

---

## Features

| `/ask` menu option | What happens |
|---|---|
| 🏗️ Build / extend the server | Describe your server and the AI designs and builds it on top of what exists |
| ⚡ Quick-start templates | Gaming, community, friends, study, business, creator, anime, esports, roleplay, dev |
| 🤖 Add bots | Pick from popular bots (MEE6, Carl-bot, Dyno, Ticket Tool…), paste custom IDs/invite links, or let the AI choose. You get one-click invite links with your server pre-selected |
| 👋 Welcome & goodbye | Welcome embed with `{user}`, `{username}`, `{server}`, `{membercount}`, optional DM, goodbye message |
| 🎭 Auto join role | Roles given on join, with a separate role for bots |
| 🛡️ AutoMod | Discord's built-in AutoMod: word filters, presets (profanity, slurs, sexual content), spam and mention raids, alerts and timeouts |
| 🌐 Community mode | Creates rules/updates channels if needed and turns Community on |
| 🧭 Onboarding | Onboarding questions that give roles and channels, plus default channels |
| 🪪 Server profile info | Name, description, icon (URL, or AI-generated with a fal key), banner, locale, system channels |
| 🎨 Self-roles menu | Button or dropdown role pickers |
| ✅ Verification gate | Verify button, locked categories, and the role for existing members so nobody gets locked out |
| 🎫 Ticket system | "Open ticket" button that makes private channels with staff and a close button |
| 📣 Post an announcement / message | The AI writes and posts it, with optional link buttons and pings |
| 📦 Move messages & panels | Move verification/ticket/role panels (their buttons keep working) or recent chat to another channel |
| 📜 Rules & info | Read-only info channels with well-written embeds |

You can also skip the menu and type anything: `/ask prompt: build me a cozy Minecraft server with a staff team and event channels`.

---

## 1. Create the bot on Discord

1. Go to <https://discord.com/developers/applications> → **New Application** → give it a name (e.g. *GuildSmith*).
2. **Bot** tab:
   - Click **Reset Token** → **copy the token** (you need it for `.env`, never share it).
   - Under **Privileged Gateway Intents**, turn ON **SERVER MEMBERS INTENT** → **Save Changes**. Welcome messages and auto roles need it.
   - Also turn ON **MESSAGE CONTENT INTENT** if you want the AI to move *other people's* messages (otherwise Discord hides their text from bots). Moving the bot's own panels, and the right-click **Move message** command, work without it.
3. Invite it to your server. When the bot starts it prints an invite link in the console, or build it yourself:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=8
   ```
   (`APPLICATION_ID` is on the **General Information** tab. `permissions=8` is Administrator, which the bot needs to build everything.)
4. In your server: **Server Settings → Roles** → drag the bot's role to the **very top**. The bot can only manage roles below its own.

---

## 2. Build & test on your Windows PC

### Install the tools (one time)
1. **Node.js 22 LTS**: <https://nodejs.org> → download the LTS installer → Next, Next, Finish.
2. **Git**: <https://git-scm.com/download/win> (or download the repo as a ZIP from GitHub).
3. *(Optional, for the free local AI)* **Ollama for Windows**: <https://ollama.com/download>. It runs in the tray after install. Then open PowerShell and run:
   ```powershell
   ollama pull qwen3:4b
   ```
   (If you skip this, use a cloud provider with `/provider set`.)

### Get the code and configure it
Open **PowerShell**:
```powershell
cd $HOME\Desktop
git clone https://github.com/cat-things/discord-ai.git
cd discord-ai
copy .env.example .env
notepad .env
```
In Notepad set:
```ini
DISCORD_TOKEN=paste-your-bot-token-here
DEV_GUILD_ID=your-test-server-id     # makes slash commands appear instantly while testing
```
To get the server ID: Discord → **User Settings → Advanced → Developer Mode ON**, then right-click your server icon → **Copy Server ID**.

### Build and run
```powershell
npm install
npm run build
npm start
```
Or just **double-click `start-windows.bat`**, which installs, builds and starts everything.

You should see:
```
✅ GuildSmith is online as GuildSmith#1234 in 1 server(s).
   Invite me: https://discord.com/oauth2/authorize?client_id=...
```

### Test it in Discord
1. `/provider set provider: Ollama (local, free)`. Or pick a cloud AI and paste its key in the pop-up.
2. `/provider test` checks that the AI answers.
3. `/ask` opens the menu. Try **⚡ Quick-start templates → Gaming**.
4. `/modify prompt: rename the general chat to lounge and make the staff category private`. You get an approval preview because it changes existing stuff.
5. `npm test` runs the automated test suite if you want to double-check the build.

Press **Ctrl+C** in PowerShell to stop the bot.

---

## 3. Run it 24/7 on your old Debian server

### Easy way (installer script)
SSH into the Debian box and run:
```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/cat-things/discord-ai.git ~/guildsmith
cd ~/guildsmith
cp .env.example .env
nano .env          # set DISCORD_TOKEN, and leave DEV_GUILD_ID EMPTY for 24/7 use
sudo bash deploy/install-debian.sh
```
The installer:
- installs **Node.js 22** (Debian's own package is too old),
- offers to install **Ollama** and download your `OLLAMA_MODEL`,
- runs `npm ci` and `npm run build`,
- installs a hardened **systemd service** that starts on boot and restarts on crashes.

Useful commands afterwards:
```bash
journalctl -u guildsmith -f          # live logs
sudo systemctl restart guildsmith    # restart
sudo systemctl stop guildsmith       # stop
git pull && sudo bash deploy/install-debian.sh   # update to the latest code
```

### Manual way (if you prefer)
```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
# Optional local AI
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:4b
# App
cd ~/guildsmith && npm ci && npm run build
# Service: edit the __PLACEHOLDERS__ first (user, folder, `which node`)
sudo cp deploy/guildsmith.service /etc/systemd/system/guildsmith.service
sudo nano /etc/systemd/system/guildsmith.service
sudo systemctl daemon-reload && sudo systemctl enable --now guildsmith
```

### Moving your settings from Windows to Debian (optional)
Your `/provider` setups and feature settings live in the `data/` folder. To keep them, copy **both** `data/db.json` and `data/secret.key` from the Windows folder into `~/guildsmith/data/` on Debian, then restart. The key decrypts the stored API keys. Otherwise just run `/provider set` again.

### Old PC + Ollama tips
- Pick a model that fits your RAM: `qwen3:1.7b` (~2 GB), `qwen3:4b` (~4 GB), `qwen3:8b` (~6 GB, much smarter). Set it in `.env` as `OLLAMA_MODEL`.
- Keep `OLLAMA_CONCURRENCY=1` on weak hardware. Extra requests wait in a queue and users see their position (*"You're #2 in the queue"*).
- Local models are slower and make more mistakes than cloud ones. The bot validates everything and asks the model to fix bad plans, but for big full-server builds a cloud model (Gemini, Groq and DeepSeek are cheap or free tiers) gives much better results.
- Ollama on a different machine? Set `OLLAMA_URL=http://that-machine-ip:11434` and start Ollama there with `OLLAMA_HOST=0.0.0.0`.

---

## Commands

All commands are **admin-only** (Administrator permission). Server owners can change this under *Server Settings → Integrations*, but the bot also re-checks Administrator on every click.

| Command | What it does |
|---|---|
| `/provider set provider:<ai> [model]` | Pick the AI. Keyed providers open a private pop-up for the API key. The bot auto-picks the best available model and runs a test |
| `/provider model model:<id>` | Switch model (autocomplete shows the provider's live model list) |
| `/provider status` | Current provider, model, masked key, auto mode, Ollama queue |
| `/provider test` | Sends a tiny prompt and shows the answer and latency |
| `/provider reset` | Forget this server's provider and delete its key |
| `/ask [prompt]` | Build or extend the server. No prompt opens the feature menu |
| `/modify prompt:<text>` | Change or delete existing channels, roles, permissions, settings, or earlier bot builds |
| `/auto enabled:<true/false>` | Auto mode: destructive actions run without the approval step |
| Right-click a message → **Apps → Move message** | Move or copy that message (or panel) to another channel |
| `/help` | Quick help and the current AI |

---

## AI providers

| Provider | Get a key | Default model* | Notes |
|---|---|---|---|
| 🦙 Ollama (local) | none: <https://ollama.com/download> | `qwen3:4b` (`OLLAMA_MODEL`) | Free and private. Slow on weak PCs or heavy use (requests queue). Downloads the model on first use |
| ✨ Gemini | <https://aistudio.google.com/apikey> | `gemini-flash-latest` | Generous free tier |
| 🅧 Grok (xAI) | <https://console.x.ai> | newest `grok-4.x` | |
| ⚡ Groq | <https://console.groq.com/keys> | `openai/gpt-oss-120b` / `llama-3.3-70b-versatile` | Very fast, free tier |
| 🤖 OpenAI | <https://platform.openai.com/api-keys> | `gpt-5-mini` | |
| 🧠 Anthropic | <https://console.anthropic.com/settings/keys> | `claude-sonnet-5-5` | |
| 🔀 OpenRouter | <https://openrouter.ai/keys> | `openrouter/auto` | Any model, use ids like `google/gemini-2.5-flash` |
| 🎨 fal | <https://fal.ai/dashboard/keys> | `openai/gpt-5-mini` | Chat via fal's OpenRouter router. A fal key also enables **AI-generated server icons** |
| 🐉 Qwen | <https://modelstudio.console.alibabacloud.com/> | `qwen-plus` | International endpoint; set `QWEN_BASE_URL` for China |
| 🐋 DeepSeek | <https://platform.deepseek.com/api_keys> | `deepseek-chat` | Cheap |
| 🌬️ Mistral | <https://console.mistral.ai/api-keys> | `mistral-large-latest` | |
| 🇿 Z.AI (GLM) | <https://z.ai/manage-apikey/apikey-list> | newest `glm-5.x` | Set `ZAI_BASE_URL` for the GLM Coding Plan endpoint |

\*Model names change constantly, so the bot doesn't trust a hardcoded list. When you run `/provider set` without a model, it **asks the provider which models exist** and picks the best one from its preference list. If a model gets retired later, it **switches automatically** on the next request. You can always pick one yourself with `/provider model`.

Each server configures its own provider and key. As the bot owner you can also put keys in `.env` (e.g. `GEMINI_API_KEY`) as a fallback for servers that haven't set one.

---

## Safety: what needs approval

- **Runs immediately:** creating roles (without staff permissions), categories, channels, AutoMod rules, welcome/auto-role/ticket/verification/role-menu setups, bot invite links, and posting messages that don't ping anyone.
- **Needs your OK** (preview with *Run everything* / *Only safe steps* / *Cancel*) unless `/auto` is on:
  - deleting or editing existing channels, categories, roles or AutoMod rules,
  - changing permissions, server settings, Community mode or Onboarding,
  - mass role assignment,
  - moving, editing or deleting existing messages,
  - messages that ping `@everyone`, `@here` or a role,
  - creating roles with **dangerous permissions** (Administrator, Manage Server/Roles/Channels/Webhooks, Kick, Ban, Timeout, Mention Everyone).
- **Always blocked, even in auto mode:**
  - handing out staff/admin roles automatically (auto role, role menus, verification, mass-assign to everyone),
  - an admin editing or deleting roles **at or above their own highest role**. This mirrors Discord's own rule, so the bot can't be used to get around the role hierarchy. The server owner is exempt.
- Messages the AI writes only ping when the plan asks for it and you approve it. Moved messages never re-ping anyone.
- Moving a message reposts it and only deletes the original after the copy is posted. If a plan moves messages out of a channel and also deletes that channel, the delete always runs last.
- API keys are typed into a private pop-up (never visible in chat), encrypted with AES-256-GCM in `data/db.json`, and shown masked (`sk-a…9xYz`).
- Each build is saved to a short history, so `/modify prompt: undo the last build` knows exactly what was created.

> ⚠️ With `/auto` on, a vague request like "clean up the server" can really delete things. There's no undo button, so be specific.

---

## About "adding bots automatically"

Fully automatic bot adding isn't possible, and that's a Discord rule, not a missing feature. Discord requires a real person to click **Authorize** (sometimes with a captcha) every time a bot is added to a server. No bot, OAuth app or API is allowed to skip that step. The only way around it would be scripting your user account (self-botting), which breaks Discord's Terms of Service and gets accounts banned.

What GuildSmith does instead:
- **One-click links:** pick bots from the menu, paste client IDs or invite links, or let the AI recommend some. Each link has your server pre-selected and the right permissions filled in, so you just press **Authorize**.
- Before showing a link, the bot checks with Discord which app the ID really belongs to and puts that name on the button.
- **Manual:** open the bot's website or top.gg → *Invite* → choose your server.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Discord refused the "Server Members" intent` | Developer Portal → Bot → enable **SERVER MEMBERS INTENT** → Save → restart |
| Slash commands don't show up | With `DEV_GUILD_ID` set they only appear in that server. Without it, global commands can take a few minutes; also try restarting Discord (Ctrl+R) |
| Commands show up twice | You switched from `DEV_GUILD_ID` to global. The bot cleans this up on the next start; restart it once |
| `Missing permissions` / role errors | Give the bot **Administrator** and drag its role to the **top** of the role list |
| `Ollama isn't running` | Start the Ollama app (Windows) or `sudo systemctl start ollama` (Debian). Check `OLLAMA_URL` |
| Local AI is very slow | Use a smaller model (`qwen3:1.7b`) or a cloud provider. The first request also loads the model into RAM |
| `The AI didn't return a usable plan` | Small models sometimes produce broken JSON. Rephrase, split the request into smaller asks, or use a stronger model |
| Announcement/stage channels became text/voice | They need Community mode. Ask for Community first (menu → 🌐) |
| Onboarding fails | Discord needs Community mode and 7+ default channels, 5+ of which everyone can chat in. The bot tops up the list automatically, but very small servers may need more channels |
| Welcome/tickets/role buttons stopped working | They need the bot online. Check `journalctl -u guildsmith -f` |
| "That message came back empty" when moving | Turn on **MESSAGE CONTENT INTENT** (Developer Portal → Bot), or use right-click → Apps → Move message, which works without it |
| Moved messages show an "APP" tag | Discord can't move messages, so other people's messages are reposted through a webhook with their name and avatar. Discord labels webhook messages |

### Project layout
```
src/
  index.ts            bot startup, command registration, events
  interactions.ts     routes slash commands, buttons, menus, modals
  commands/           /provider, /ask (+ menu, bots), /modify, /auto, /help, Move message
  ai/                 providers, HTTP clients, planner prompt, JSON repair, Ollama queue
  discord/            server snapshot, action schemas, executor, safety rules, message moving, live features
  storage/            JSON database + API key encryption
  tests/              node:test suite (npm test), fully offline with fakes
deploy/               systemd service + Debian installer
```
