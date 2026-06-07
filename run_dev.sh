#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

export SERVER_URL="ws://localhost:3000"
export SERVER_HOSTNAME="localhost:3000"
export PUBLIC_URL="http://localhost:3000"
export PORT=3000

# Per-user isolated data dirs (like tests/start-test-env.js)
ALICE_DATA="$ROOT/.dev-data/alice"
BOB_DATA="$ROOT/.dev-data/bob"
X2_DATA="$ROOT/.dev-data/x2"

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

# Fresh data dirs — keep .claude symlinks
for d in alice bob; do
  rm -rf "$ROOT/.dev-data/$d"
  mkdir -p "$ROOT/.dev-data/$d/.claude"
  ln -sf ~/.claude/.credentials.json "$ROOT/.dev-data/$d/.claude/.credentials.json" 2>/dev/null || true
done
rm -rf "$X2_DATA"
mkdir -p "$X2_DATA"

echo "==> Building client (dev mode)..."
(cd "$ROOT/client" && npx vite build --mode development)

echo "==> Starting server on :$PORT  ($SERVER_LOG)"
(cd "$ROOT/server" && X2_DATA_DIR="$X2_DATA" node src/index.js) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 20); do
  sleep 0.3
  if curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; then break; fi
done

# ── Register alice and bob via headless helper ─────────────────────────────────
echo "==> Registering alice and bob..."
(cd "$ROOT" && node --input-type=module <<'JSEOF'
import { headlessRegister, generateTestKeypair } from './tests/oauth-flow.js';
import { writeFileSync } from 'fs';
const BASE = 'http://localhost:3000';

for (const username of ['alice', 'bob']) {
  const kp = await generateTestKeypair();
  await headlessRegister({ serverBase: BASE, username, ...kp });
  // Write key path to a temp file so the host can find it
  writeFileSync(`/tmp/codette-dev-${username}-keydir`, kp.dir);
  console.log(`registered ${username} -> ${kp.dir}`);
}
JSEOF
)

ALICE_KEYDIR=$(cat /tmp/codette-dev-alice-keydir)
BOB_KEYDIR=$(cat /tmp/codette-dev-bob-keydir)

echo "==> Starting host1: alice ($HOST1_LOG)"
(cd "$ROOT/host" && CODETTE_DATA_HOME="$ALICE_KEYDIR" CLAUDE_CONFIG_DIR="$ALICE_DATA/.claude" \
  node index.js --server "$SERVER_URL" --username alice --password pass1 --no-dir-privacy --permission-mode default) \
  >"$HOST1_LOG" 2>&1 &
HOST1_PID=$!

echo "==> Starting host2: bob ($HOST2_LOG)"
(cd "$ROOT/host" && CODETTE_DATA_HOME="$BOB_KEYDIR" CLAUDE_CONFIG_DIR="$BOB_DATA/.claude" \
  node index.js --server "$SERVER_URL" --username bob --password pass2) \
  >"$HOST2_LOG" 2>&1 &
HOST2_PID=$!

printf '%s\n' "$SERVER_PID" "$HOST1_PID" "$HOST2_PID" > "$PIDFILE"

echo "==> Press Ctrl+C to stop  (pids: $SERVER_PID, $HOST1_PID, $HOST2_PID)"
tail -f "$SERVER_LOG" "$HOST1_LOG" "$HOST2_LOG"
