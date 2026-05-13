#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

set -e

# claudew host installer
# usage: ./install.sh
# env vars can be pre-set or entered interactively

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# load .env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$SCRIPT_DIR/.env"; set +a
fi

ask() {
  printf '%s [%s]: ' "$1" "$2"
  read -r val
  printf '%s' "${val:-$2}"
}

SERVER_URL="${SERVER_URL:-$(ask 'Server URL' 'wss://chat.example.com')}"
echo
HOST_KEY="${HOST_KEY:-$(ask 'Host key (shared with server)' 'host-key-change-me')}"
echo
CLIENT_USERNAME="${CLIENT_USERNAME:-$(ask 'Username' "$(whoami)")}"
echo
CLIENT_PASSWORD="${CLIENT_PASSWORD:-$(ask 'Password' 'changeme')}"
echo

# write run script
cat > "$SCRIPT_DIR/run.sh" <<EOF
#!/bin/sh
export SERVER_URL='$SERVER_URL'
export HOST_KEY='$HOST_KEY'
export CLIENT_USERNAME='<username>'
export CLIENT_PASSWORD='<password>'
exec node '$SCRIPT_DIR/host/index.js' "\$@"
EOF
chmod +x "$SCRIPT_DIR/run.sh"
echo "wrote $SCRIPT_DIR/run.sh"

# optional systemd service
printf 'Install systemd user service? [y/N]: '
read -r yn
if [ "$yn" = "y" ] || [ "$yn" = "Y" ]; then
  SERVICE_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_DIR/claudew-host.service" <<EOF
[Unit]
Description=claudew host
After=network.target

[Service]
ExecStart=$SCRIPT_DIR/run.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable claudew-host
  systemctl --user start claudew-host
  echo "service installed and started"
  echo "  logs: journalctl --user -u claudew-host -f"
else
  echo "run with: $SCRIPT_DIR/run.sh"
fi
