#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

set -e

# Codette host installer
# Server-served: curl -fsSL https://your-server/install.sh | sh
#   (SERVER_URL and HOST_KEY are baked in by the server)
# Local clone:   ./install.sh
#   (prompts for SERVER_URL and HOST_KEY interactively)

REPO_URL="https://github.com/danlkv/codette.git"
INSTALL_DIR="$HOME/.local/share/codette"
CONFIG_DIR="$HOME/.config/codette"
BIN_DIR="$HOME/.local/bin"

# ── Server URL and host key ──────────────────────────────────────────────────
# When served by the server, these are replaced with actual values.
# When run locally, they fall back to env vars or interactive prompts.
SERVER_URL="${CODETTE_SERVER_URL:-}"
HOST_KEY="${CODETTE_HOST_KEY:-}"

# Read from /dev/tty so prompts work even when piped (curl | sh)
ask() {
  printf '%s [%s] (press Enter for default): ' "$1" "$2" > /dev/tty
  read -r val < /dev/tty
  echo "${val:-$2}"
}

# Derive HTTP URL from WS URL for tarball fallback
http_url() {
  echo "$SERVER_URL" | sed 's|^wss://|https://|;s|^ws://|http://|'
}

if [ -z "$SERVER_URL" ]; then
  SERVER_URL=$(ask "Server URL" "ws://localhost:3000")
fi
if [ -z "$HOST_KEY" ]; then
  HOST_KEY=$(ask "Host key" "host-key-change-me")
fi

echo "Installing codette host..."

# 1. Clone or update source — try git, fall back to server tarball
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing installation..."
  if ! git -C "$INSTALL_DIR" fetch --depth 1 origin --quiet 2>/dev/null; then
    echo "git fetch failed, downloading tarball from server..."
    curl -fsSL "$(http_url)/host.tar.gz" | tar xz -C "$INSTALL_DIR" --strip-components=0
  else
    git -C "$INSTALL_DIR" reset --hard origin/HEAD --quiet
  fi
elif command -v git >/dev/null 2>&1 && git clone --depth 1 --quiet "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
  :  # cloned silently
else
  echo "git unavailable or clone failed, downloading tarball from server..."
  mkdir -p "$INSTALL_DIR"
  curl -fsSL "$(http_url)/host.tar.gz" | tar xz -C "$INSTALL_DIR" --strip-components=0
fi

# 2. Install host dependencies
(cd "$INSTALL_DIR/host" && npm ci --silent)

# 3. Prompt for username and password
DEFAULT_USER="$(whoami)"
DEFAULT_PASS="$(LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 10)"

cat >/dev/tty <<EXPLAIN

──────────────────────────────────────────────────────────────────
Set up login credentials for your browser to connect to this host.

  • These are NEW credentials, just for codette — not your system
    or any existing account. You'll type them once in the browser
    when you visit the codette server.
  • Defaults are auto-generated (a random password). Press Enter
    to accept, or type your own.
  • One host runs per username at a time. If you install codette
    on multiple machines and want them online concurrently, give
    each a different username.
  • Saved to: $CONFIG_DIR/credentials.json
    (you can edit or re-read this file later).
──────────────────────────────────────────────────────────────────

EXPLAIN

USERNAME=$(ask "Username" "$DEFAULT_USER")
PASSWORD=$(ask "Password" "$DEFAULT_PASS")

# 4. Write credentials.json
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/credentials.json" <<CRED
{
  "server": "$SERVER_URL",
  "hostKey": "$HOST_KEY",
  "username": "$USERNAME",
  "password": "$PASSWORD"
}
CRED
chmod 600 "$CONFIG_DIR/credentials.json"
echo "Wrote $CONFIG_DIR/credentials.json"

# 5. Symlink binary
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/host/index.js" "$BIN_DIR/codette"
chmod +x "$INSTALL_DIR/host/index.js"

# 6. Check PATH and print summary
HOST_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$INSTALL_DIR/host/package.json','utf8')).version)")
echo ""
case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "Codette host v${HOST_VER} installed at $BIN_DIR/codette"
    echo "Run:  codette"
    ;;
  *)
    echo "Add to your shell profile:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    echo "Codette host v${HOST_VER} installed at $BIN_DIR/codette"
    echo "Run:  ~/.local/bin/codette"
    ;;
esac
