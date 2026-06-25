#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov
#
# Drive the interactive `codette login` flow against a local dev server.
# Server lifecycle is delegated to `run_dev.sh --server-only`; this script
# only owns the isolated $HOME, the login dance, and the host spawn.
#
# Re-running is cheap: credentials.json under .dev-data/login-user/ is reused.
# Delete that file (or .dev-data/codette/) to force a fresh login dance.

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
USER_HOME="$ROOT/.dev-data/login-user"
USER_CONFIG="$USER_HOME/.config/codette"
USER_CLAUDE="$USER_HOME/.claude"
USER_DATA="$USER_HOME/.local/share/codette"
CREDS_FILE="$USER_CONFIG/credentials.json"
HOST_LOG=/tmp/dev-login-host.log

# Auto-load Google OIDC client config if a Google-Console-style secret file is
# present at $ROOT/.dev-data/oauth/client_secret_*.json. Exports the two env
# vars the server reads (GOOGLE_OIDC_CLIENT_ID, GOOGLE_OIDC_CLIENT_SECRET).
# The picker hides the Google button when these are unset.
GOOGLE_SECRETS_FILE=""
for D in "$ROOT/.dev-data/oauth" "$ROOT/.dev-data" "$ROOT/../../.dev-data/oauth" "$ROOT/../../.dev-data"; do
  CAND=$(find "$D" -maxdepth 1 -name 'client_secret_*.json' ! -name '*.Zone.Identifier' 2>/dev/null | head -1)
  if [ -n "$CAND" ]; then GOOGLE_SECRETS_FILE="$CAND"; break; fi
done
if [ -n "$GOOGLE_SECRETS_FILE" ]; then
  GOOGLE_OIDC_CLIENT_ID=$(node -e "const f=JSON.parse(require('fs').readFileSync('$GOOGLE_SECRETS_FILE'));process.stdout.write((f.web||f.installed||{}).client_id||'')")
  GOOGLE_OIDC_CLIENT_SECRET=$(node -e "const f=JSON.parse(require('fs').readFileSync('$GOOGLE_SECRETS_FILE'));process.stdout.write((f.web||f.installed||{}).client_secret||'')")
  if [ -n "$GOOGLE_OIDC_CLIENT_ID" ] && [ -n "$GOOGLE_OIDC_CLIENT_SECRET" ]; then
    export GOOGLE_OIDC_CLIENT_ID GOOGLE_OIDC_CLIENT_SECRET
    echo "==> Google OIDC: enabled (client_id=${GOOGLE_OIDC_CLIENT_ID%%-*}…)"
    echo "    Register this redirect_uri with Google Console: http://localhost:3000/register/callback"
  else
    echo "==> Google OIDC: secrets file found but client_id/secret missing — skipping"
  fi
else
  echo "==> Google OIDC: disabled (no $ROOT/.dev-data/oauth/client_secret_*.json)"
fi

# Start the dev server via run_dev.sh, or reuse one that's already up.
if curl -sf http://localhost:3000/ >/dev/null 2>&1; then
  echo "==> Reusing existing server on :3000 (will not inherit GOOGLE_OIDC_* env from this script)"
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
