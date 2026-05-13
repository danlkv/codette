# Codette

> Control your local Claude Code from a mobile-friendly browser UI, anywhere. Self-hosted, end-to-end encrypted, with multi-host multi-device support.

A three-piece system that lets you run Claude Code on your laptop and drive it from a browser on your phone, tablet, or any other machine. Approve tool calls, kick off new prompts, and watch output stream in real time — over the public internet, without exposing your machine.

## How it works

```mermaid
flowchart LR
    H["host<br/>(your laptop)<br/>runs Claude"]
    S["server<br/>(relay)<br/>routes messages"]
    C["client<br/>(browser on phone)<br/>Svelte SPA"]

    H <-->|WebSocket| S
    S <-->|WebSocket| C
```

- **host** — Node process on your local machine. Spawns Claude Code, connects to the server, streams output.
- **server** — Express + WebSocket relay. Routes messages between hosts and clients. Handles login, JWTs, file serving.
- **client** — Svelte SPA. Login, session sidebar, chat view with markdown and tool-call rendering, inline file panels.

Run the server anywhere reachable from the public internet (a $5/mo VPS works). Run the host on the machine where you want Claude to do real work. Open the client in any browser to drive it.

## Quick start

**Server** (run on a VPS or any internet-reachable machine):

```sh
cd server && npm install && node src/index.js
```

**Host** (run on the machine where Claude runs):

```sh
./install.sh   # interactive setup, writes run.sh, optionally installs systemd service
./run.sh
```

Or manually:

```sh
cd host && npm install
CLIENT_USERNAME=you CLIENT_PASSWORD=pass HOST_KEY=secret SERVER_URL=wss://yourserver node index.js
```

**Client** — the server serves the pre-built client from `client/dist/`. To rebuild:

```sh
cd client && npm install && npm run build
```

## Auth

The host registers a username + password with the server at connect time. Clients log in with those credentials and receive a JWT (7-day expiry). All API routes and the client WebSocket require a valid JWT.

Multiple clients can connect to the same host. Multiple hosts (different usernames) can connect to the same server; the server routes messages by JWT.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant H as Host

    Note over H,S: Host registers at startup
    H->>S: register(username, password, HOST_KEY)
    S-->>H: connection ack

    Note over C,S: Client logs in
    C->>S: POST /login {username, password}
    S-->>C: JWT (7-day)

    Note over C,H: Steady-state messaging
    C->>S: WebSocket {jwt, prompt}
    S->>H: route by username
    H-->>S: stream tokens
    S-->>C: stream tokens
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SERVER_URL` | `ws://localhost:3000` | Server WebSocket URL (host → server) |
| `CLIENT_USERNAME` | `whoami` | Username for web login |
| `CLIENT_PASSWORD` | `changeme` | Password for web login |
| `HOST_KEY` | `host-key-change-me` | Shared secret between host and server |
| `JWT_SECRET` | `jwt-secret-change-me` | JWT signing secret (server) |
| `PORT` | `3000` | Server listen port |

Change every default before exposing the server to the public internet.

## Status

Early. Working end-to-end. Issues and PRs welcome.

## Related projects

- [Claude Code remote control](https://code.claude.com/docs/en/remote-control) — Anthropic's official remote access feature
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) — desktop-focused Claude Code web UI
- [chadbyte/clay](https://github.com/chadbyte/clay) — similar three-piece architecture
- [sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui) — local-only browser UI

## License

[TBD]
