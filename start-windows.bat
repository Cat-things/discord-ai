@echo off
title GuildSmith
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo [!] Created .env - paste your DISCORD_TOKEN into it, save, close Notepad, then run this file again.
  notepad .env
  pause
  exit /b 1
)

if not exist node_modules (
  echo [*] Installing dependencies...
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)

echo [*] Building...
call npm run build
if errorlevel 1 ( pause & exit /b 1 )

echo [*] Starting GuildSmith (close this window or press Ctrl+C to stop)
node dist\index.js
pause
