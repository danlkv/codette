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

COOKIE_SECRET=$(openssl rand -hex 32)
DEFAULT_HOSTNAME=$(hostname -f 2>/dev/null || echo "localhost")
SERVER_HOSTNAME=$(ask "Server hostname" "$DEFAULT_HOSTNAME")

# Derive a sensible PUBLIC_URL default
if [ "$SERVER_HOSTNAME" = "localhost" ] || [ "$SERVER_HOSTNAME" = "127.0.0.1" ]; then
  DEFAULT_PUBLIC_URL="http://$SERVER_HOSTNAME:3000"
else
  DEFAULT_PUBLIC_URL="https://$SERVER_HOSTNAME"
fi
PUBLIC_URL=$(ask "Public URL (OAuth issuer)" "$DEFAULT_PUBLIC_URL")

cat > "$ENV_FILE" <<EOF
COOKIE_SECRET=$COOKIE_SECRET
SERVER_HOSTNAME=$SERVER_HOSTNAME
PUBLIC_URL=$PUBLIC_URL
EOF

echo ""
echo "Wrote $ENV_FILE"
echo ""
echo "Start the server:"
echo "  docker compose up -d                      # no TLS (localhost only)"
echo "  docker compose --profile tls up -d        # with TLS via Caddy"
echo ""
echo "Then on each host machine:"
echo "  curl -fsSL https://$SERVER_HOSTNAME/install.sh | sh"
echo "  codette login"
