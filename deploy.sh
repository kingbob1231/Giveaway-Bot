#!/usr/bin/env bash
# Run this script on your VPS to build and start the bot.
# Usage: bash deploy.sh
set -e

echo "==> Loading .env"
set -a; source .env; set +a

echo "==> Installing dependencies"
pnpm install --frozen-lockfile

echo "==> Pushing database schema"
pnpm --filter @workspace/db run push

echo "==> Registering Discord slash commands"
pnpm --filter @workspace/api-server run register

echo "==> Building server"
pnpm --filter @workspace/api-server run build

echo "==> Creating logs directory"
mkdir -p logs

echo "==> Starting with PM2"
pm2 start ecosystem.config.cjs --env production
pm2 save

echo ""
echo "Done! Bot is running."
echo "Check status: pm2 status"
echo "Check logs:   pm2 logs giveaway-bot"
