#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Override any of these via env
export HOST_KEY="${HOST_KEY:-host-key-change-me}"
export SERVER_URL="${SERVER_URL:-ws://localhost:3000}"
export CLIENT_USERNAME="${CLIENT_USERNAME:-$(whoami)}"
export CLIENT_PASSWORD="${CLIENT_PASSWORD:-changeme}"
export PORT="${PORT:-3000}"

SERVER_LOG=/tmp/e2e-server.log
HOST_LOG=/tmp/e2e-host.log

cleanup() {
  echo "Stopping..."
  kill "$SERVER_PID" "$HOST_PID" 2>/dev/null || true
  wait "$SERVER_PID" "$HOST_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Building client..."
(cd "$ROOT/client" && npm run build)

echo "==> Starting server on :$PORT  ($SERVER_LOG)"
(cd "$ROOT/server" && node src/index.js) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

echo "==> Starting host ($HOST_LOG)"
(cd "$ROOT/host" && node index.js) >"$HOST_LOG" 2>&1 &
HOST_PID=$!

echo "==> Press Ctrl+C to stop"
tail -f "$SERVER_LOG" "$HOST_LOG"
