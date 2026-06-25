# Codette

<p align="center">
  <img src="doc/Codette-mobile-dark-pendulum.png" width="320" alt="Codette mobile UI" />
</p>

> Control your local Claude Code from a mobile-friendly browser UI, anywhere. Self-hosted, end-to-end encrypted, with multi-host multi-device support.

A three-piece system that lets you run Claude Code on your laptop and drive it from a browser on your phone, tablet, or any other machine. Kick off new prompts and watch output stream in real time — over the public internet, without exposing your machine.

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

## Auth & encryption

The host generates an EC P-256 keypair on first run and sends the public key to the server. Clients log in with username + password via HMAC-based challenge-response; the host signs a JWT with its private key, the server verifies with the public key. The password never reaches the server.

When a password is set, the client and host independently derive AES-GCM-256 encryption keys from it. All message content is encrypted end-to-end — the server relays opaque ciphertext and cannot read session data, file contents, or git diffs. See [`doc/auth.spec.md`](doc/auth.spec.md) for the full protocol.

Multiple clients can connect to the same host. Multiple hosts (different usernames) can connect to the same server; the server routes messages by JWT.

## Environment variables

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `SERVER_HOSTNAME` | _(required for `/install.sh`)_ | Hostname served in the install script |
| `PUBLIC_URL` | `http://localhost:PORT` | Used as JWT issuer and audience root |
| `CODETTE_DATA_DIR` | `/data/codette` | Stores `id-key.pem`, `username-owners.json`, `claim-limits.json` |
| `TRIAL_MAX_CLAIMS` | `5` | Max registrations per claim-limit key in the window |
| `TRIAL_WINDOW_MS` | `1296000000` (15d) | Sliding window for the claim-limits ledger |
| `CODETTE_TRACE` | off | Set to `1` for protocol-level trace logging |

External OIDC providers (Google, GitHub, …) are configured by uncommenting their entry in [`oidc-providers.jsonc`](oidc-providers.jsonc) and setting the env vars that entry references. The shipped template uses `<NAME>_OIDC_CLIENT_ID` / `<NAME>_OIDC_CLIENT_SECRET` per provider (e.g. `GOOGLE_OIDC_CLIENT_ID`, `GITHUB_OIDC_CLIENT_ID`). Any `${VAR}` referenced by an uncommented entry must be set — the server refuses to start otherwise, listing every missing variable.

### Host

| Variable | Default | Description |
|---|---|---|
| `CODETTE_SERVER_URL` | `ws://localhost:3000` | Server WebSocket URL |
| `CODETTE_USERNAME` | `$(whoami)` | Username for web login |
| `CODETTE_PASSWORD` | `changeme` | Password for web login (chat-domain HMAC) |
| `CODETTE_DATA_HOME` | platform default | Host data directory (`host-key.pem`, session names) |
| `E2E` | on | Set to `0` to disable e2e encryption (debug only) |

Legacy env vars also supported on host: `SERVER_URL`, `CLIENT_USERNAME`, `CLIENT_PASSWORD`.

## Registration

After installing, run `codette login` to register the host's identity with the server. The CLI:
1. Prompts for username and a browser password.
2. Opens the server's picker page in your browser.
3. After you pick an IdP — "Sign in with Google" or "Try without an account" — and complete it, polls until registration is confirmed.
4. Writes `~/.config/codette/credentials.json`.

The host receives no access or refresh tokens. The host's `host-key.pem` keypair is its identity; the IdP verification only authorizes the username binding.

## Related projects

- [Claude Code remote control](https://code.claude.com/docs/en/remote-control) — Anthropic's official remote access feature
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) — desktop-focused Claude Code web UI
- [chadbyte/clay](https://github.com/chadbyte/clay) — local daemon with multi-vendor support (Claude + Codex)
- [sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui) — local-only browser UI