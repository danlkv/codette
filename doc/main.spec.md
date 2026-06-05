# Web-chat wrapper for claude.

1. Server serves a chat-like svelte webapp. Webapp accepts on login/password
2. Server listens for chat events from host and passes them onto user. Receives
   user messages and passes back to host.
3. Host: starts claude in background with json protocol. Connects to server.
   allows user to talk to claude through web. Renders chat in CLI just as normal claude would.

## Web UI

### Message rendering
- Assistant responses rendered as markdown (bold, italic, code blocks, lists, tables, links).
- User messages shown as plain pre-wrapped text.
- Streaming cursor (▌) appended to the last paragraph during generation.

### Tool display
Each tool call shown as a single row beneath the message text:
```
⚙ ToolName  <key arg>
```
Key arg extracted per tool:
- **Bash** — first non-comment line of the command
- **WebSearch** — the query string
- **Read** - file path
- **Write / Edit** — file path, expand to see content
- **Grep** — pattern

### Interactive tool blocks
Certain tools render as interactive blocks instead of the standard tool row:
- **AskUserQuestion** → `QuestionBlock`: clickable option buttons, "Other" free text input. Single-select single-question responds immediately on click. Multi-question shows "Submit answers" button.
- **ExitPlanMode** → `PlanBlock`: shows allowed tools/prompts from the plan, "view plan" button to open the `.md` plan file in the file viewer, Approve/Reject buttons (reject accepts optional feedback).
- **Other tools** (when `--permission-mode default`) → `PermissionBlock`: tool name + collapsible input detail, Allow/Deny buttons.

Active (unresolved) blocks have a colored border (amber for question/permission, blue for plan). Resolved blocks fade to neutral border + reduced opacity. See [`protocol.spec.md`](protocol.spec.md) for permission mode behavior by backend and history replay semantics.

### Slash commands
Typed in the input bar; handled client-side before sending to claude.

| Command | Effect |
|---------|--------|
| `/clear` | Clear local message history |
| `/compact [hint]` | Send compact instruction to claude |
| `/usage` | Show session cost from last result event |
| `/status` | Show host/ws connection status |
| `/model <name>` | Switch model (sends claude `/model` command) |
| `/btw <question>` | Side question — not added to conversation history |
| `/inline-files` | Instruct agent to use inline file viewer in current session |


### Session management

Claude has /resume. We support list of sessions in collapsible sidebar.
Webapp receives list of sessions and what agents are active and with what sessions.

Common flow - active agent up and standby, cold start.
1. User opens webapp, app loads list of sessions and last message timestamps.
2. app opens the session, displays a "ai" marker in top bar to indicate agent is up, requests chat
   history.
   - list of sessions has dot indicator left of session title: green = agent idle/standby, orange pulsing = agent running. No dot for just-selected inactive session.
   - Active agent sessions show interrupt (⊘) and stop (■) buttons. Inactive sessions show delete (×) button instead.
3. server forwards request to host, logs message.
4. host finds jsonl storage corresponding to the session, passes it to client through server
5. Client loads the messages, caches into local storage.
6. User sends a message, it gets passed to claude through server (logs) and host. websocket.
7. Claude works, producing messages, user sees the messages in order.
8. User disconnects, claude may continue running and producing messages.

Then:
active agent up and responding, hot start.
1. User (re)loads app. App requests list of sessions+timestamps, active agents
2. app sees that active session is in local storage. If timestamp is more recent than the recent
   message in local storage, it requests chat history (with since=timestamp).
3. User starts receiving new messages through websocket.
4. User switches to another session, app requests chat history (if not cached)
5. History is displayd in chat, topbar agent indicator is inactive, messages displayed.
6. Button next to textboxs says "send and start".
7. User switches back to session with active agent. Messages were obtained in background and are now
   displayed. Claude keeps thinking.
8. User interrupts an agent, host sends SIGUSR1 to interrupt Claude. 
9. Clicks active agent indicator to stop agent process. 
10. Indicator turns to cross user may delete the session. topbar agent indicator turns inactive.

Multi-client.
no agents running.
1. Client joins session, requests run state (sesions+timestamps, active agents).
2. User sees last session, "send and start" button. types message, sends and agents starts up on
   host.
3. Another client connects to server. Requests sessions+timestamps, active agents.
4. New client requests history and starts receiving new messages from claude just like first client.
5. New client switches to session B and sees the messages, caches them.
6. Original client still sees session A.
7. New client deletes a session C, once host deletes it, server broadcasts new session list.
8. Original client's ui stops showing session C in list.

### File management

As a subsection in sidebar below session list section, user can explore directory tree at session's
home dir. User can click on a file and the main area
will render the file instead of chat.

### Inline file viewer

Agent can quote source files inline in chat using a `sourcefile` code fence. The UI renders
it as a scrollable file panel instead of raw code. When creating a new session, the user can
check "instruct agent to use inline file viewer" — this appends a system prompt teaching the
agent the syntax. See `inline-file.spec.md`.

## Host terminal
- Colored output: `you` (blue), `claude` (green), tool calls (yellow + dim summary), cost (dim).
- Tool summary shown inline: `⚙ Bash  echo "hello"`, `⚙ Read  src/index.js`, etc.

### Multi-host

- Host connects to the server and specifies user and password to use.
- Server checks if there exists an active user with same name and accepts if not.
- Client(s) may connect to the particular host, specifying their username and password that host
  declared.
- Server has no client config


## Host Setup

### Install

Server serves a shell script at `GET /install.sh` with `SERVER_URL` baked in. The script delivers the binary only — no credentials are interpolated.

```
curl -fsSL https://your-server:3000/install.sh | sh
```

The script:
1. Clones the GitHub repo into `~/.local/share/codette/`
2. Runs `npm install --prefix ~/.local/share/codette/host`
3. Writes `~/.config/codette/config.json` (mode 0644):
   ```json
   { "server": "wss://your-server:3000" }
   ```
4. Symlinks `~/.local/bin/codette` → `~/.local/share/codette/host/index.js`
5. If `~/.local/bin` is not in `$PATH`, prints:
   ```
   Add to your shell profile:
     export PATH="$HOME/.local/bin:$PATH"
   ```
6. Prints `Run:  codette login`

### Activation (`codette login`)

The host CLI obtains credentials via OAuth 2.0 Authorization Code + PKCE. See `auth.spec.md` (Host registration via OAuth) for the full flow. Summary:

1. `codette login` opens a browser at `/oauth/auth` and listens on a free `localhost:<port>`.
2. User clicks **Try without registration for N days** on the consent page.
3. Browser returns to a server-rendered intermediate page that posts the auth code to `localhost:<port>` (or, if codette is on a remote machine, displays the code for copy-paste into the CLI prompt).
4. CLI exchanges the code for `{access_token, refresh_token}` and persists them to `~/.config/codette/credentials.json` (mode 0600).
5. CLI starts the host process. The `access_token` is sent as `?token=…` on the `/host` WebSocket connection.

### Startup

On connect the host prints the server URL and credentials so the user can log in:
```
Connected to https://your-server:3000
  Username: dan
  Password: a3kR4mXq2p
```

### Config precedence

CLI flags → env vars → `~/.config/codette/credentials.json` (secrets, 0600) → `~/.config/codette/config.json` (non-secret, 0644) → defaults. Env beats persisted state so debug overrides like `CODETTE_SERVER_URL=ws://localhost:3000` work against an installation that already has a saved server URL.

| Setting | Config file / key | Env var | CLI flag | Default |
|---------|-------------------|---------|----------|---------|
| Server URL | `config.json: server` | `CODETTE_SERVER_URL` | `--server`, `-s` | `ws://localhost:3000` |
| Refresh token | `credentials.json: refresh_token` | — | — | _obtained via `codette login`_ |
| Username | (chosen at OAuth claim time) | `CODETTE_USERNAME` | `--username`, `-u` | `$(whoami)` |
| Password | `credentials.json: password` | `CODETTE_PASSWORD` | `--password`, `-p` | _user-chosen at login_ |

Hosts authenticate to `/host` WS by sending a fresh `access_token` (obtained by exchanging the persisted `refresh_token` at startup) as the `?token=` query parameter.

### CLI

```
codette [options]          # connect to server
codette update             # git pull + npm install
```

### Update

`codette update` pulls latest source and reinstalls host dependencies.

### Login page

When no host is connected, the login page displays:
```
Download and install host:
  curl -fsSL https://your-server:3000/install.sh | sh
```

## Deployment
- Server in Docker, port bound to localhost only.
- nginx reverse proxy at `chat.example.com` with Let's Encrypt SSL.
- Host connects locally via `wss://chat.example.com`.
