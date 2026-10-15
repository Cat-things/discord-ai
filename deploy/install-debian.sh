#!/usr/bin/env bash
# Installs GuildSmith as a 24/7 systemd service on Debian/Ubuntu.
# Usage (from the project folder):  sudo bash deploy/install-debian.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
SERVICE_FILE=/etc/systemd/system/guildsmith.service

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo:  sudo bash deploy/install-debian.sh"
  exit 1
fi
cd "$APP_DIR"

echo "==> GuildSmith installer (app: $APP_DIR, runs as: $SERVICE_USER)"

# 1. Config
if [[ ! -f .env ]]; then
  cp .env.example .env
  chown "$SERVICE_USER" .env
  echo "Created $APP_DIR/.env. Put your DISCORD_TOKEN in it (nano .env), then run this script again."
  exit 1
fi
if ! grep -qE '^DISCORD_TOKEN=.+' .env; then
  echo "DISCORD_TOKEN is empty in $APP_DIR/.env. Add it (nano .env) and run this script again."
  exit 1
fi
if grep -qE '^DEV_GUILD_ID=.+' .env; then
  echo "Note: DEV_GUILD_ID is set, so commands only show up in that one server. Clear it in .env for 24/7 use."
fi

# 2. Node.js 22 LTS (Debian's own package is too old)
NODE_MAJOR=0
command -v node >/dev/null 2>&1 && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "==> Installing Node.js 22 LTS from NodeSource"
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "==> Node $(node -v) at $NODE_BIN"

# 3. Optional: Ollama for the free local AI
if grep -qE '^DEFAULT_PROVIDER=ollama' .env || ! grep -qE '^DEFAULT_PROVIDER=' .env; then
  read -rp "Install/update Ollama (free local AI) on this machine? [Y/n] " answer || answer=""
  if [[ ! "$answer" =~ ^[Nn] ]]; then
    command -v ollama >/dev/null 2>&1 || curl -fsSL https://ollama.com/install.sh | sh
    MODEL="$(grep -E '^OLLAMA_MODEL=' .env | cut -d= -f2- || true)"
    MODEL="${MODEL:-qwen3:4b}"
    systemctl enable --now ollama >/dev/null 2>&1 || true
    echo "==> Downloading model $MODEL (can take a while)"
    ollama pull "$MODEL"
  fi
fi

# 4. Build as the service user
echo "==> Installing dependencies and building"
sudo -u "$SERVICE_USER" bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund && npm run build"
mkdir -p "$APP_DIR/data"
chown -R "$SERVICE_USER" "$APP_DIR/data"
chmod 700 "$APP_DIR/data"
chmod 600 "$APP_DIR/.env"

# 5. systemd service
echo "==> Installing $SERVICE_FILE"
sed -e "s#__USER__#$SERVICE_USER#g" -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__NODE__#$NODE_BIN#g" deploy/guildsmith.service >"$SERVICE_FILE"
systemctl daemon-reload
systemctl enable guildsmith >/dev/null
systemctl restart guildsmith
sleep 3
systemctl --no-pager --lines=15 status guildsmith || true

cat <<EOF

✅ GuildSmith is installed and starts automatically on boot.
   Live logs:   journalctl -u guildsmith -f
   Restart:     sudo systemctl restart guildsmith
   Stop:        sudo systemctl stop guildsmith
   Update:      git pull && sudo bash deploy/install-debian.sh
EOF
