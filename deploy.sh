#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

# Deploy webchat to a remote host
# usage: ./deploy.sh [remote-host]
set -euo pipefail

REMOTE="${1:-example.com}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

case "$REMOTE" in
  example.com)
    REMOTE_DIR="/home/user/codette"
    DOMAIN="chat.example.com"
    ;;
  *)
    echo "Unknown host: $REMOTE. Add it to deploy.sh or set REMOTE_DIR/DOMAIN."; exit 1
    ;;
esac

# ── 1. Build client locally ───────────────────────────────────────────────────
echo "==> building client"
npm --prefix "${ROOT}/client" install --silent
npm --prefix "${ROOT}/client" run build

# ── 2. Sync source + pre-built dist ──────────────────────────────────────────
echo "==> syncing to ${REMOTE}:${REMOTE_DIR}"
rsync -az --delete --exclude={node_modules,.env} \
  "${ROOT}/" "${REMOTE}:${REMOTE_DIR}/"

ssh "$REMOTE" bash <<ENVSSH
set -e
if [ ! -f "${REMOTE_DIR}/.env" ]; then
  p=\$(openssl rand -hex 16); j=\$(openssl rand -hex 32); h=\$(openssl rand -hex 32)
  printf 'CHAT_USERNAME=admin\nCHAT_PASSWORD=%s\nJWT_SECRET=%s\nHOST_KEY=%s\n' \
    "\$p" "\$j" "\$h" > "${REMOTE_DIR}/.env"
  echo "==> .env created:"; cat "${REMOTE_DIR}/.env"
fi
cd "${REMOTE_DIR}" && docker-compose down && docker-compose up -d --build server
ENVSSH

echo "==> verifying"
for i in 1 2 3 4 5; do
  code=$(curl -so /dev/null -w "%{http_code}" --max-time 5 "https://${DOMAIN}/api/auth/challenge" \
    -X POST -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo 0)
  [ "$code" = "503" ] && break
  echo "  attempt $i: got $code, retrying…"; sleep 3
done
if [ "$code" = "503" ]; then
  echo "OK https://${DOMAIN} (auth endpoint responds)"
else
  echo "WARN: login endpoint returned $code — containers may still be starting"
fi

key=$(ssh "$REMOTE" "grep ^HOST_KEY ${REMOTE_DIR}/.env | cut -d= -f2")
echo "Host: HOST_KEY=${key} CLIENT_USERNAME=<hostname> CLIENT_PASSWORD=<password> SERVER_URL=wss://${DOMAIN} node host/index.js"
