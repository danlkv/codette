#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov
#
# Drive the interactive `codette login` flow against a local dev server.
# Server lifecycle is delegated to `run_dev.sh --server-only`; this script
# only owns the isolated $HOME, the login dance, and the host spawn.
#
# Re-running is cheap: credentials.json under .dev-data/login-user/ is reused.
# Delete that file (or .dev-data/oauth/) to force a fresh login dance.

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
USER_HOME="$ROOT/.dev-data/login-user"
USER_CONFIG="$USER_HOME/.config/codette"
USER_CLAUDE="$USER_HOME/.claude"
USER_DATA="$USER_HOME/.local/share/codette"
CREDS_FILE="$USER_CONFIG/credentials.json"
HOST_LOG=/tmp/dev-login-host.log

# Start the dev server via run_dev.sh, or reuse one that's already up.
if curl -sf http://localhost:3000/ >/dev/null 2>&1; then
  echo "==> Reusing existing server on :3000"
  RUNDEV_PID=""
else
  echo "==> Starting run_dev.sh --server-only"
  "$ROOT/run_dev.sh" --server-only &
  RUNDEV_PID=$!
  for _ in $(seq 1 20); do
    curl -sf http://localhost:3000/ >/dev/null 2>&1 && break
    sleep 0.3
  done
fi

cleanup() {
  echo "Stopping..."
  [ -n "$HOST_PID"    ] && kill "$HOST_PID"    2>/dev/null || true
  [ -n "$RUNDEV_PID"  ] && kill "$RUNDEV_PID"  2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Isolated $HOME so codette login writes credentials.json under .dev-data/.
mkdir -p "$USER_CONFIG" "$USER_CLAUDE" "$USER_DATA"
if [ -f ~/.claude/.credentials.json ] && [ ! -L "$USER_CLAUDE/.credentials.json" ]; then
  ln -sf ~/.claude/.credentials.json "$USER_CLAUDE/.credentials.json"
fi
cat > "$USER_CONFIG/config.json" <<JSON
{ "server": "ws://localhost:3000" }
JSON

if [ -f "$CREDS_FILE" ]; then
  echo "==> credentials.json already at $CREDS_FILE — skipping login (delete to redo)"
else
  HOME="$USER_HOME" \
  CODETTE_DATA_HOME="$USER_DATA" \
  CLAUDE_CONFIG_DIR="$USER_CLAUDE" \
    node "$ROOT/host/index.js" login
  [ -f "$CREDS_FILE" ] || { echo "Login did not produce credentials.json — aborting."; exit 1; }
fi

echo
echo "==> Starting host using $CREDS_FILE ($HOST_LOG)"
(cd "$ROOT/host" && \
  HOME="$USER_HOME" \
  CODETTE_DATA_HOME="$USER_DATA" \
  CLAUDE_CONFIG_DIR="$USER_CLAUDE" \
  node index.js --no-dir-privacy --permission-mode default \
) >"$HOST_LOG" 2>&1 &
HOST_PID=$!

USERNAME=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$CREDS_FILE','utf8')).username)")
echo "==> Web UI: http://localhost:3000 (sign in as: $USERNAME, password in $CREDS_FILE)"
echo "==> Ctrl+C to stop."
tail -f "$HOST_LOG"
