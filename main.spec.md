# Web-chat wrapper for claude.

Setup.

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
- **Read / Write / Edit** — file path
- **Grep** — pattern

### Slash commands
Typed in the input bar; handled client-side before sending to claude.

| Command | Effect |
|---------|--------|
| `/clear` | Clear local message history |
| `/compact [hint]` | Send compact instruction to claude |
| `/resume <id>` | Resume a session by ID |
| `/usage` | Show session cost from last result event |
| `/status` | Show host/ws connection status |
| `/model <name>` | Switch model (sends claude `/model` command) |
| `/btw <question>` | Side question — not added to conversation history |

## Host terminal
- Colored output: `you` (blue), `claude` (green), tool calls (yellow + dim summary), cost (dim).
- Tool summary shown inline: `⚙ Bash  echo "hello"`, `⚙ Read  src/index.js`, etc.

## Deployment
- Server in Docker, port bound to localhost only.
- nginx reverse proxy at `chat.example.com` with Let's Encrypt SSL.
- Host script runs locally, connects via `wss://chat.example.com`.
