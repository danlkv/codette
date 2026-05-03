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

## Host terminal
- Colored output: `you` (blue), `claude` (green), tool calls (yellow + dim summary), cost (dim).
- Tool summary shown inline: `⚙ Bash  echo "hello"`, `⚙ Read  src/index.js`, etc.

## Deployment
- Server in Docker, port bound to localhost only.
- nginx reverse proxy at `chat.example.com` with Let's Encrypt SSL.
- Host script runs locally, connects via `wss://chat.example.com`.
