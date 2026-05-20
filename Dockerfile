# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

# ── Stage 1: build client ─────────────────────────────────────────────────────
FROM node:20-alpine AS client-builder
WORKDIR /app
COPY client/package*.json client/
RUN npm --prefix client ci
COPY client/ client/
COPY shared/ shared/
RUN npm --prefix client run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY shared/ /app/shared/
COPY host/index.js host/package.json host/package-lock.json host/renderer.js host/rpc.js /app/host/
COPY install.sh /app/install.sh
COPY --from=client-builder /app/client/dist /app/client/dist
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "src/index.js"]
