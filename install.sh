#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov
#
# Codette host installer
# Server-served:  curl -fsSL https://your-server/install.sh | sh
#   (SERVER_URL is baked in)
# Local clone:    ./install.sh
#   (prompts for SERVER_URL)

set -e

REPO_URL="https://github.com/danlkv/codette.git"
INSTALL_DIR="$HOME/.local/share/codette"
CONFIG_DIR="$HOME/.config/codette"
BIN_DIR="$HOME/.local/bin"

SERVER_URL="${CODETTE_SERVER_URL:-}"

ask() {
  printf '%s [%s] (press Enter for default): ' "$1" "$2" > /dev/tty
  read -r val < /dev/tty
  echo "${val:-$2}"
}

http_url() { echo "$SERVER_URL" | sed 's|^wss://|https://|;s|^ws://|http://|'; }

if [ -z "$SERVER_URL" ]; then
  SERVER_URL=$(ask "Server URL" "ws://localhost:3000")
fi

echo "Installing codette host..."

# Clone or update — try git, fall back to server tarball
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing installation..."
  if ! git -C "$INSTALL_DIR" fetch --depth 1 origin --quiet 2>/dev/null; then
    echo "git fetch failed, downloading tarball from server..."
    curl -fsSL "$(http_url)/host.tar.gz" | tar xz -C "$INSTALL_DIR" --strip-components=0
  else
    git -C "$INSTALL_DIR" reset --hard origin/HEAD --quiet
  fi
elif command -v git >/dev/null 2>&1 && git clone --depth 1 --quiet "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
  :
else
  echo "git unavailable or clone failed, downloading tarball from server..."
  mkdir -p "$INSTALL_DIR"
  curl -fsSL "$(http_url)/host.tar.gz" | tar xz -C "$INSTALL_DIR" --strip-components=0
fi

(cd "$INSTALL_DIR/host" && npm ci --silent)

mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/config.json" <<JSON
{ "server": "$SERVER_URL" }
JSON

mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/host/index.js" "$BIN_DIR/codette"
chmod +x "$INSTALL_DIR/host/index.js"

HOST_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$INSTALL_DIR/host/package.json','utf8')).version)")
echo ""
case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "Codette host v${HOST_VER} installed at $BIN_DIR/codette"
    echo "Run:  codette login"
    ;;
  *)
    echo "Add to your shell profile:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    echo "Codette host v${HOST_VER} installed at $BIN_DIR/codette"
    echo "Run:  ~/.local/bin/codette login"
    ;;
esac
