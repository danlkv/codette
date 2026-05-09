# webplugin

Web chat interface for Claude Code. A server relays messages between a browser client and a host process that runs Claude locally.

## Components

- **server** — Express + WebSocket relay server. Handles auth (JWT), session history, file serving, and message routing.
- **host** — Node script that runs on your local machine. Spawns Claude, connects to the server via WebSocket, and streams output.
- **client** — Svelte SPA. Login, session sidebar, chat view with markdown/tool rendering, inline file panels.

## Quick start

```sh
# Start the server
cd server && npm install && node src/index.js

# Start the host (on your local machine)
cd host && npm install
CLIENT_USERNAME=you CLIENT_PASSWORD=pass HOST_KEY=secret SERVER_URL=ws://localhost:3000 node index.js

# Build and serve the client (or let server serve dist/)
cd client && npm install && npm run build
```

## Auth

The host registers a username and password with the server at connect time. Browser clients log in with those credentials and receive a JWT (7-day expiry). All API routes and the client WebSocket connection require a valid JWT.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SERVER_URL` | `ws://localhost:3000` | Server WebSocket URL (host) |
| `CLIENT_USERNAME` | `whoami` | Username for web login |
| `CLIENT_PASSWORD` | `changeme` | Password for web login |
| `HOST_KEY` | `host-key-change-me` | Shared secret between host and server |
| `JWT_SECRET` | `jwt-secret-change-me` | JWT signing secret (server) |
| `PORT` | `3000` | Server listen port |

## See also

- https://github.com/siteboon/claudecodeui
- https://patapim.ai/about/
- https://github.com/chadbyte/clay
