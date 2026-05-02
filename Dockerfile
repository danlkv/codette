# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/ ./
COPY --from=client-build /app/client/dist /app/client/dist
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "src/index.js"]
