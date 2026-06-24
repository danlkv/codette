#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

# Codette server bootstrap — generates .env for docker compose
set -e

ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"

if [ -f "$ENV_FILE" ]; then
  echo ".env already exists at $ENV_FILE"
  echo "Delete it first if you want to regenerate."
  exit 1
fi

ask() {
  printf '%s [%s]: ' "$1" "$2"
  read -r val
  echo "${val:-$2}"
}

DEFAULT_HOSTNAME=$(hostname -f 2>/dev/null || echo "localhost")
SERVER_HOSTNAME=$(ask "Server hostname" "$DEFAULT_HOSTNAME")
PUBLIC_URL="https://$SERVER_HOSTNAME"

cat > "$ENV_FILE" <<EOF
SERVER_HOSTNAME=$SERVER_HOSTNAME
PUBLIC_URL=$PUBLIC_URL
EOF

echo ""
echo "Wrote $ENV_FILE"
echo ""
echo "The server will auto-generate its id_token signing key on first run"
echo "(stored in /data/codette inside the container)."
echo ""
echo "Start the server:"
echo "  docker compose up -d                      # no TLS (localhost only)"
echo "  docker compose --profile tls up -d        # with TLS via Caddy"
echo ""
echo "Then install the host on any machine:"
echo "  curl -fsSL https://$SERVER_HOSTNAME/install.sh | sh"
