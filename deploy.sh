#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

# Deploy codette server to a remote host
# usage: ./deploy.sh <remote-host> [remote-dir]
set -euo pipefail

REMOTE="${1:?Usage: ./deploy.sh <remote-host> [remote-dir]}"
REMOTE_DIR="${2:-/opt/codette}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── 1. Sync source to remote ─────────────────────────────────────────────────
echo "==> syncing to ${REMOTE}:${REMOTE_DIR}"
rsync -az --delete \
  --exclude={node_modules,.env,.dev-data,_worktrees,test-results,client/dist} \
  "${ROOT}/" "${REMOTE}:${REMOTE_DIR}/"

# ── 2. Init + build on remote ────────────────────────────────────────────────
ssh "$REMOTE" bash <<ENDSSH
set -e
cd "${REMOTE_DIR}"
if [ ! -f .env ]; then
  echo "==> running init.sh"
  ./init.sh
fi
echo "==> building and starting containers"
docker compose up -d --build
ENDSSH

echo "==> deployed to ${REMOTE}:${REMOTE_DIR}"
