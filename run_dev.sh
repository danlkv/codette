#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Local-dev defaults.
export SERVER_URL="ws://localhost:3000"
export SERVER_HOSTNAME="localhost:3000"
export PORT=3000
export OAUTH_DATA_DIR="$ROOT/.dev-data/oauth"
export COOKIE_SECRET="dev-secret"
export PUBLIC_URL="http://localhost:$PORT"

SERVER_LOG=/tmp/e2e-server.log
HOST1_LOG=/tmp/e2e-host1.log
HOST2_LOG=/tmp/e2e-host2.log
PIDFILE=/tmp/e2e-dev.pids

cleanup() {
  echo "Stopping..."
  kill "$SERVER_PID" "$HOST1_PID" "$HOST2_PID" 2>/dev/null || true
  wait "$SERVER_PID" "$HOST1_PID" "$HOST2_PID" 2>/dev/null || true
  rm -f "$PIDFILE"
}
trap cleanup EXIT INT TERM

# Kill stale processes from previous runs
if [ -f "$PIDFILE" ]; then
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$PIDFILE"
  rm -f "$PIDFILE"
  sleep 0.5
fi
fuser -k "$PORT"/tcp 2>/dev/null || true
sleep 0.3

echo "==> Building client (dev mode)..."
(cd "$ROOT/client" && npx vite build --mode development)

echo "==> Starting server on :$PORT  ($SERVER_LOG)"
(cd "$ROOT/server" && OAUTH_DATA_DIR="$OAUTH_DATA_DIR" COOKIE_SECRET="$COOKIE_SECRET" PUBLIC_URL="$PUBLIC_URL" node src/index.js) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

mkdir -p "$ROOT/.dev-data/alice/.claude" "$ROOT/.dev-data/bob/.claude" "$ROOT/.dev-data/oauth"
# Symlink Claude credentials so dev hosts can spawn Claude
for d in "$ROOT/.dev-data/alice/.claude" "$ROOT/.dev-data/bob/.claude"; do
  [ -L "$d/.credentials.json" ] || ln -sf ~/.claude/.credentials.json "$d/.credentials.json"
done

# Mint OAuth tokens programmatically (no browser needed — mintAccessToken uses the
# headless PKCE flow in tests/oauth-flow.js against the local server).
echo "==> Minting OAuth tokens for alice and bob..."
sleep 2  # let server bind
TOKEN_ALICE=$(node -e "
import('./tests/oauth-flow.js').then(async ({ mintAccessToken }) => {
  const t = await mintAccessToken({ serverBase: 'http://localhost:$PORT', username: 'alice' });
  process.stdout.write(t.access_token);
}).catch(e => { console.error(e.message); process.exit(1); });
")
TOKEN_BOB=$(node -e "
import('./tests/oauth-flow.js').then(async ({ mintAccessToken }) => {
  const t = await mintAccessToken({ serverBase: 'http://localhost:$PORT', username: 'bob' });
  process.stdout.write(t.access_token);
}).catch(e => { console.error(e.message); process.exit(1); });
")

echo "==> Starting host1: alice ($HOST1_LOG)"
(cd "$ROOT/host" && CODETTE_DATA_HOME="$ROOT/.dev-data/alice" CLAUDE_CONFIG_DIR="$ROOT/.dev-data/alice/.claude" CODETTE_ACCESS_TOKEN="$TOKEN_ALICE" node index.js --server "$SERVER_URL" --username alice --password pass1 --no-dir-privacy --permission-mode default) >"$HOST1_LOG" 2>&1 &
HOST1_PID=$!

echo "==> Starting host2: bob ($HOST2_LOG)"
(cd "$ROOT/host" && CODETTE_DATA_HOME="$ROOT/.dev-data/bob" CLAUDE_CONFIG_DIR="$ROOT/.dev-data/bob/.claude" CODETTE_ACCESS_TOKEN="$TOKEN_BOB" node index.js --server "$SERVER_URL" --username bob --password pass2) >"$HOST2_LOG" 2>&1 &
HOST2_PID=$!

printf '%s\n' "$SERVER_PID" "$HOST1_PID" "$HOST2_PID" > "$PIDFILE"

echo "==> Press Ctrl+C to stop  (pids: $SERVER_PID, $HOST1_PID, $HOST2_PID)"
tail -f "$SERVER_LOG" "$HOST1_LOG" "$HOST2_LOG"
