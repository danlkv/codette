#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov
#
# Local dev environment that exercises the real `codette login` browser flow.
# Differs from run_dev.sh: that script mints tokens headlessly via the test
# helper; this one runs the actual interactive PKCE dance (browser, consent
# page, /auth/success → localhost callback). Useful for poking the OAuth UX.
#
# Re-running is cheap: server-side OAuth state under .dev-data/oauth is kept
# between runs so the existing refresh_token in credentials.json stays live and
# `codette login` is skipped. Pass --fresh to wipe both .dev-data/oauth and the
# host's credentials.json and re-run the full sign-in dance.

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    -h|--help)
      echo "Usage: $0 [--fresh]"
      echo "  --fresh   wipe .dev-data/oauth and credentials.json before running"
      exit 0
      ;;
  esac
done

# ── Server config (localhost issuer — COOKIE_SECRET dev default is OK) ──────
export PORT=3000
export OAUTH_DATA_DIR="$ROOT/.dev-data/oauth"
export COOKIE_SECRET="dev-secret"
export PUBLIC_URL="http://localhost:$PORT"
export SERVER_HOSTNAME="localhost:$PORT"

# ── Isolated $HOME so credentials.json lands under .dev-data, not yours ─────
USER_HOME="$ROOT/.dev-data/login-user"
USER_CONFIG="$USER_HOME/.config/codette"
USER_CLAUDE="$USER_HOME/.claude"
USER_DATA="$USER_HOME/.local/share/codette"
CREDS_FILE="$USER_CONFIG/credentials.json"

SERVER_LOG=/tmp/dev-login-server.log
HOST_LOG=/tmp/dev-login-host.log
PIDFILE=/tmp/dev-login.pids

cleanup() {
  echo "Stopping..."
  [ -n "$HOST_PID"   ] && kill "$HOST_PID"   2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -f "$PIDFILE"
}
trap cleanup EXIT INT TERM

# Kill stale processes from previous runs
if [ -f "$PIDFILE" ]; then
  while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$PIDFILE"
  rm -f "$PIDFILE"
  sleep 0.5
fi
fuser -k "$PORT"/tcp 2>/dev/null || true
sleep 0.3

if [ "$FRESH" = 1 ]; then
  echo "==> --fresh: wiping .dev-data/oauth and credentials.json"
  rm -rf "$ROOT/.dev-data/oauth"
  rm -f  "$CREDS_FILE"
fi

mkdir -p "$OAUTH_DATA_DIR" "$USER_CONFIG" "$USER_CLAUDE" "$USER_DATA"

# Symlink Claude credentials so the host can spawn Claude
if [ -f ~/.claude/.credentials.json ] && [ ! -L "$USER_CLAUDE/.credentials.json" ]; then
  ln -sf ~/.claude/.credentials.json "$USER_CLAUDE/.credentials.json"
fi

# Pre-write config.json so `codette login` knows the server URL without env vars
cat > "$USER_CONFIG/config.json" <<JSON
{ "server": "ws://localhost:$PORT" }
JSON

echo "==> Building client (dev mode)..."
(cd "$ROOT/client" && npx vite build --mode development)

echo "==> Starting server on :$PORT  ($SERVER_LOG)"
(cd "$ROOT/server" && node src/index.js) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait for server to bind
for _ in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

# Decide whether to run `codette login`. Skip if credentials.json already
# exists AND the OAuth state directory still has tokens — i.e., the previous
# refresh_token is likely still valid. (`--fresh` deleted both so this branch
# falls through to the login step.)
if [ -f "$CREDS_FILE" ] && [ -d "$OAUTH_DATA_DIR" ] && [ -n "$(ls -A "$OAUTH_DATA_DIR" 2>/dev/null)" ]; then
  echo "==> credentials.json already present at $CREDS_FILE — skipping codette login"
  echo "    (pass --fresh to force a new sign-in dance)"
else
  echo "==> Running \`codette login\` against http://localhost:$PORT"
  # Run login interactively with isolated $HOME.
  HOME="$USER_HOME" \
  CODETTE_DATA_HOME="$USER_DATA" \
  CLAUDE_CONFIG_DIR="$USER_CLAUDE" \
    node "$ROOT/host/index.js" login

  if [ ! -f "$CREDS_FILE" ]; then
    echo "Login did not produce credentials.json — aborting."
    exit 1
  fi
fi

echo
echo "==> Starting host using credentials at $CREDS_FILE ($HOST_LOG)"
(cd "$ROOT/host" && \
  HOME="$USER_HOME" \
  CODETTE_DATA_HOME="$USER_DATA" \
  CLAUDE_CONFIG_DIR="$USER_CLAUDE" \
  node index.js --no-dir-privacy --permission-mode default \
) >"$HOST_LOG" 2>&1 &
HOST_PID=$!

printf '%s\n' "$SERVER_PID" "$HOST_PID" > "$PIDFILE"

USERNAME=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$CREDS_FILE','utf8')).username)")

cat <<DONE

──────────────────────────────────────────────────────────────
Web UI:  http://localhost:$PORT
  • Sign in with username: $USERNAME
  • Password: see $CREDS_FILE

PIDs: server=$SERVER_PID  host=$HOST_PID
Logs: $SERVER_LOG  |  $HOST_LOG
Ctrl+C to stop both.
──────────────────────────────────────────────────────────────

DONE

tail -f "$SERVER_LOG" "$HOST_LOG"
