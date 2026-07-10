# Protocol Specification

Three-layer protocol. REST for stateless reads/writes, WebSocket for push events and
the stateful host stdin pipe.

```
Claude process  ←stdin/stdout→  Host  ←/host WS→  Server  ←REST+WS→  Clients
```

**Convention:** message fields invented by this app (not part of Claude CLI/Code) are prefixed
`codette_` (e.g. `codette_settings`).

---

## Layer 1 — Claude ↔ Host (stream-json stdio)

Standard Claude CLI stream-json protocol. Full event reference with examples: [`doc/claude-jsonl.md`](doc/claude-jsonl.md). Host spawns claude with:
```
claude --dangerously-skip-permissions \
       --input-format stream-json \
       --output-format stream-json \
       --include-partial-messages \
       --verbose \
       [--resume <sessionId>]
```

### Claude → Host (stdout)

| type | key fields | notes |
|------|-----------|-------|
| `system`    | `subtype:"init"`, `session_id`, `cwd` | first event |
| `assistant` | `message.{id,content}` | streamed; `text` and `tool_use` blocks |
| `tool`      | `message.content[]` (tool_result items) | host forwards to server |
| `user`      | `message.content: ToolResultBlock[]` | tool results only; **initial user message is NOT emitted on stdout** (session file only) |
| `result`    | `subtype`, `total_cost_usd`, `usage` | end of turn |

### Host → Claude (stdin)

| type | key fields |
|------|-----------|
| `user` | `role:"user"`, `content: string` |

---

## Layer 2 — Host ↔ Server (WebSocket `/host?proof=JWT&clientUsername=NAME`)

### Registration REST API

| method | path | query / body | response | notes |
|--------|------|------|----------|-------|
| `GET` | `/register/start` | `state`, `username`, `jwk` (b64url JSON), `host_proof` (JWT) | HTML (picker page) | validates host_proof, stores pending state, sets CSRF cookie. Picker shows one button per configured IdP (Google button omitted when `GOOGLE_OIDC_CLIENT_ID` unset). |
| `POST` | `/register/finish-trial` | form: `csrf`, `state` | 302 → `/register/callback?state=…&id_token=…` | trial-IdP path. CSRF check, claim-limits check, self-issues id_token. |
| `GET` | `/register/callback` | `state` + (`id_token` OR `code`) | HTML (done page) | `id_token` arrives from self-IdP redirect; `code` arrives from Google's redirect — server exchanges code at Google's token endpoint to obtain id_token. Then verifies via `verifyIdToken` dispatcher and claims binding. |
| `GET` | `/register/status` | `state` | `{status: 'pending'\|'claimed'\|'expired'\|'error'}` | CLI polls this; returns immediately |
| `GET` | `/auth/username-available/:name` | — | `{available: bool, reason?: 'invalid'\|'taken'}` | pre-flight check; advisory only |



One persistent connection. Close codes: `1008` — authentication rejection
(invalid proof, username mismatch); `4001` — superseded by a newer connection
presenting a valid proof for the same key. Host reconnects after 3 s on any
close except `4001`, on which it exits.

### Host → Server

| type | key fields | notes |
|------|-----------|-------|
| `log` | `level`, `msg`, `data?`, `ts` | server buffers last 500 |
| `claude_line` | `sessionId`, `line` | every stdout line; server broadcasts to all WS clients |
| `agent_event` | `sessionId`, `event` | state transition; server broadcasts and updates agent map |
| `session_list` | `sessions: Session[]`, `hostCwd: string`, `models: {value, displayName}[]` | response to `list_sessions`; server caches and returns via REST. `models` from SDK `supportedModels()`, fetched once from the first live agent |
| `permission_request` | `sessionId`, `toolUseId`, `toolName`, `input`, `title?`, `displayName?`, `description?` | SDK `canUseTool` callback; server broadcasts to clients. Host stores `{handler, input}` in `pendingPermissions` keyed by `toolUseId` |

**`agent_event` values:** `started` · `streaming` · `idle` · `stopped`

**Session object:**
```json
{ "id": "string", "title": "string", "ts": 1234567890123,
  "msgCount": 12, "cwd": "/path", "agentState": "running"|"idle"|null }
```
`agentState` is added by the server's `enrichSessions()` from the `agents` map; `null` means no agent running.

### Server → Host

| type | key fields | notes |
|------|-----------|-------|
| `list_sessions` | — | on host connect; response populates server's session cache |
| `delete_session` | `sessionId`, `nonce?`, `ciphertext?` | delete `.jsonl` file; host sends updated `session_list`. Under e2e the request carries an encrypted empty `{}` body — host rejects plaintext when `encKey` is derived |
| `agent_ctl` | `sessionId`, `event`, event-specific fields | `stop`: kill process · `interrupt`: SIGUSR1 · `set_model {model}`: apply to the live agent via the SDK, or on the auto-resume triggered by the session's next message. Unknown events are ignored |
| `user` | `sessionId`, `message: {role, content}`, `cwd?`, `codette_settings?` | forward to claude stdin; host auto-resumes if no agent running. `sessionId === '__new__'` spawns a fresh claude using `cwd` (validated against `process.cwd()` + `ALLOWED_PREFIXES`, override with `--no-dir-privacy`) |
| `permission_response` | `toolUseId`, `allow: bool`, `message?`, `updatedInput?` | client decision; host merges `{...originalInput, ...updatedInput}` before resolving SDK promise (SDK replaces, not merges) |

---

## Layer 3 — Server ↔ Client

### REST API

JWT in `Authorization: Bearer <token>` header (obtained via challenge/verify flow).

| method | path | body / query | response | notes |
|--------|------|------|----------|-------|
| `POST` | `/api/auth/challenge` | `{username}` | `{nonce}` | no auth; server forwards to host RPC |
| `POST` | `/api/auth/verify` | `{username, nonce, response}` | `{token}` | HMAC-SHA256 response; sets `username` cookie; no capabilities — e2e is implicit from password |
| `GET` | `/api/sessions` | — | `{sessions: Session[], hostCwd: string}` | cached session list from host; clients should prefer WS `list_sessions` for fresh data |
| `GET` | `/api/sessions/:id/history` | `?offset=N` / `?limit=N` / `?offset=N&limit=M` | `{lines: string[], totalLines: number, incremental: bool}` | raw JSONL lines; `?limit=N` → last N lines; `?offset=N&limit=M` → lines [N, N+M); `?offset=N` → lines [N, end). Server dedup key: `sessionId:offset:limit` |
| `DELETE` | `/api/sessions/:id` | `?enc=<packed>` | 204 | broadcasts new `session_list` from host over WS. Under e2e the client sends `?enc=base64url(nonce ‖ ciphertext)` (encrypting `'{}'`); server `unpackParam`s and forwards `{nonce, ciphertext}` to the host alongside the plaintext `sessionId` routing field |
| `PUT` | `/api/sessions/:id/name` | `{enc}` or `{name}` | `{ok}` | rename a session. Under e2e the body is `{enc: base64url(nonce ‖ ciphertext)}` encrypting `{name}`; without e2e the plaintext `{name}` form is accepted for debug |
| `GET` | `/api/logs` | `?fmt=text` | JSON array or plain text | `x-host-key` auth |
| `GET` | `/*` | — | `index.html` | SPA fallback |

### WebSocket `/ws?token=JWT`

Push events and stateful commands only. No capability negotiation on connect — the client sends `list_sessions` as the first message (encrypted if keys exist).

**Server → Client (all broadcast)**

| type | key fields | notes |
|------|-----------|-------|
| `session_list` | `sessions: Session[]` | any session change; `hostCwd` is REST-only |
| `claude_line` | `sessionId`, `line` | clients route to per-session message store |
| `agent_event` | `sessionId`, `event` | clients update `agentActive` |
| `host_status` | `connected: bool` | host connect/disconnect |
| `permission_request` | `sessionId`, `toolUseId`, `toolName`, `input`, `title?`, `displayName?`, `description?` | passthrough from host; client renders interactive block based on `toolName` |

**Client → Server**

| type | key fields | notes |
|------|-----------|-------|
| `list_sessions` | — | client requests session list; first message after WS open |
| `agent_ctl` | `sessionId`, `event`, event-specific fields | forwarded to host verbatim |
| `user` | `sessionId`, `message: {role, content}` | server forwards to host stdin; **host** echoes back as `claude_line({type:'user'})` to all clients |
| `permission_response` | `toolUseId`, `allow: bool`, `message?`, `updatedInput?` | server forwards to host blindly; `updatedInput` is a partial overlay (e.g. `{answers}` for AskUserQuestion) |

---

## Implementation Notes

**Permission mode behavior by backend:**

|                    | spawn `--dangerously-skip-permissions` | spawn `default` | SDK `bypassPermissions` | SDK `default` |
|--------------------|----------------------------------------|-----------------|-------------------------|---------------|
| Bash / Edit / etc. | auto-execute                           | blocks (no tty) | auto-execute            | web Allow/Deny |
| AskUserQuestion    | auto-rejected by CLI                   | terminal prompt | web interactive         | web interactive |
| ExitPlanMode       | auto-rejected by CLI                   | terminal prompt | web interactive         | web interactive |

SDK `bypassPermissions` is the default — interactive questions/plans without approving every tool. The SDK's `canUseTool` callback still fires for AskUserQuestion and ExitPlanMode because their `checkPermissions` always returns `{behavior:'ask'}`, regardless of permission mode.

**Permission flow (SDK backend only):** Host creates a pending Promise keyed by `toolUseId` and stores `{handler, input}`. Server broadcasts `permission_request` to all clients. Client renders an interactive block based on `toolName`:
- `AskUserQuestion` → `QuestionBlock` (clickable options, "Other" free text)
- `ExitPlanMode` → `PlanBlock` (Approve / Reject with optional feedback)
- Everything else → `PermissionBlock` (Allow / Deny with collapsible input detail)

Client sends `permission_response` with `{toolUseId, allow, updatedInput?, message?}`. Host merges `updatedInput` onto the original input (`{...pending.input, ...updatedInput}`) before resolving the SDK promise. This merge is required because the SDK does full replacement (`updatedInput` replaces `input`), so the client only needs to send the changed fields (e.g. `{answers}` for AskUserQuestion, not the full `{questions, answers}` object).

**Permission history replay:** `permission_request`/`permission_response` are WS-only — they are not persisted in the session JSONL. The client parser infers outcomes from `tool_result` events when replaying history: `is_error: false` → resolved as approved, `is_error: true` → resolved as denied. For AskUserQuestion, selected answers are extracted from the tool_result content string (SDK format: `"question"="answer"` pairs parsed via regex, or JSON `{answers}` from the updatedInput merge). PlanBlock's plan file path is inferred by finding the most recent Write tool_use targeting a `/plans/` path.

**User message echo (host):** The server does not echo user messages — it forwards them to the host, which emits a `claude_line({type:'user'})` after writing to Claude's stdin. This ensures the echo confirms delivery to the agent. On the sending client, the send button switches to a progress indicator immediately on send; it clears and the message bubble renders only when the echo `claude_line` arrives. Other clients receive the same `claude_line` broadcast and render the bubble identically.

**History relay (server):** `GET /api/sessions/:id/history` parks the HTTP response in
`pendingHistory: Map<key, entry[]>` and sends `get_session_history { sessionId, offset?, limit? }` to host over WS.
Host replies `history { sessionId, lines, totalLines }`. Server drains the map and sends HTTP response.
Concurrent requests for the same session coalesce into one WS request. Dedup key is `${sessionId}:${offset??''}:${limit??''}` — requests with different params get separate WS round-trips.

**Client history cache:** `localStorage` stores `{ lines: string[], lineCount: number }` per session.
`lineCount` = server `totalLines` at last fetch + live lines pushed since. It is **not** `lines.length` — these diverge with windowed fetches. `startLine` is derived: `lineCount - lines.length`.
On load: apply cache immediately, fetch `?offset=lineCount` for new lines.
If `totalLines < lineCount`, file was truncated — drop cache and refetch `?limit=200`.
`saveCurrentCache()` called on session switch and `beforeunload`.

**Client in-memory store:** `sessionData: Map<sessionId, string[]>` is the authoritative in-memory store for non-current sessions. On switch-away, `currentLines` is saved into `sessionData`; background `claude_line` events push directly into it. On switch-back, `currentLines` is restored from `sessionData` with no HTTP fetch — the incremental fetch is skipped. HTTP fetch only on: initial load (no sessionData, no localStorage), page reload (sessionData gone), or WS reconnect (potential gap).

**New session flow:** clicking "+ new" switches client to local `__new__` state (no network call).
First message send goes over the WS as `user { sessionId:'__new__', cwd, codette_settings, message }` (encrypted
under e2e like any other `user` message) with `awaitingNewSession = true` set before send. Host validates
`cwd` via `cwdAllowed()` (must be under `process.cwd()` or in `ALLOWED_PREFIXES` unless `--no-dir-privacy`),
spawns claude, and writes the first message to stdin immediately — triggering `system.init`. On `system.init`,
host injects a synthetic session entry into the `session_list` broadcast (file may not exist yet). Client
auto-switches on the next `agent_event: started` for a non-current session. After `result`, host calls
`sendSessionList()` again with real file data (title, msgCount, cwd). New sessions are created exclusively
via WS — there is no REST endpoint for session creation.

**E2E enforcement (host):** when `encKey` is derived, the host rejects plaintext messages of any
client-originated type that carries security-sensitive payload:
`{ user, agent_ctl, permission_response, list_sessions, delete_session, set_session_name }`.
Server-initiated reads (`get_*`, `auth_*`) and metadata-only frames (`agent_event`, `host_status`) stay
plaintext — their outer routing fields are constructed by the relay from REST params it must already read.
The check fires after the per-field decrypt: a message that arrived as `{type, nonce, ciphertext}` and was
merged with its inner JSON sets `wasDecrypted = true` and passes; a bare-plaintext frame of a sensitive type
is dropped with a `warn` log. With `E2E=0` (no `encKey`) the check is skipped.

**Session-id validation (host):** `findSessionFile()` strictly validates `sessionId` against the canonical
Claude UUID shape (`/^[0-9a-f]{8}-…{12}$/i`) before any path operation, and verifies the resolved file path
stays under `${CLAUDE_CONFIG_DIR || ~/.claude}/projects/<project>/` via `path.relative()`. Any other shape
(including the `__new__` spawn sentinel, which is intercepted earlier in the `user` handler) yields `null`,
short-circuiting `get_session_history`, `delete_session`, and `getSessionCwd`.

**504 resilience:** `pendingHistoryHttp` entries store `{ res, incremental, offset }`.
On host reconnect, server immediately re-sends `get_session_history` for all parked requests,
preventing them from timing out after 30 s.

**Delete confirmation:** server only resolves pending `DELETE /api/sessions/:id` responses when
the session id is absent from the host's next `session_list` broadcast.


---

## Server Internal State

```
hostWs: WebSocket | null
agents: Map<sessionId, { active: bool, streaming: bool }>  // from agent_events
sessionCache: Session[]                                     // from last session_list
logBuffer: Entry[]                                         // capped at 500
```

---

## Client State Traces

Key variables: `CL` = `currentLines` count, `LC` = `lineCount`, `SD[A]` = `sessionData[A]` count, `LS` = localStorage cache. File has 1000 lines. Windowed fetch loads last 200 (lines 800–1000).

### First load (no cache)

| Step | Event | CL | LC | LS | Action |
|---|---|---|---|---|---|
| 1 | App open, WS connect | 0 | 0 | miss | Send `list_sessions` via WS |
| 2 | `session_list` received via WS | 0 | 0 | miss | Fetch `?limit=200` |
| 3 | `{lines:200, totalLines:1000}` | 200 | 1000 | — | `applyLines(lines.slice(boundary))` |
| 4 | Store cache | 200 | 1000 | `{lines:200, LC:1000}` | done; `startLine = 1000−200 = 800` |

### Streaming

| Step | Event | CL | LC | Action |
|---|---|---|---|---|
| 0 | After first load | 200 | 1000 | — |
| 1 | `claude_line` arrives | 201 | 1001 | `CL.push(line)`, `LC++`, `parseLine(line, true)` |
| 2 | `claude_line` arrives | 202 | 1002 | same |

`LC` and `CL.length` stay in sync; `startLine = LC − CL.length = 800` remains constant.

### Switch to other session while streaming

| Step | Event | CL(A) | LC(A) | SD[A] | CL(B) | LC(B) | Action |
|---|---|---|---|---|---|---|---|
| 0 | Viewing A, streaming | 202 | 1002 | 0 | — | — | — |
| 1 | User clicks B | 202 | 1002 | 0 | — | — | `saveCurrentCache()` → `LS[A]={lines:202, LC:1002}` |
| 2 | Save in-mem | — | — | 202 | — | — | `sessionData.set(A, [...CL])` |
| 3 | Reset + load B | — | — | 202 | 200 | 800 | `loadSessionHistory(B)` |
| 4 | A line arrives | — | — | 203 | 200 | 800 | `sessionData.get(A).push(line)` |
| 5 | A line arrives | — | — | 204 | 200 | 800 | same |

### Switch back to A

| Step | Event | CL | LC | SD[A] | Action |
|---|---|---|---|---|---|
| 0 | `SD[A]`=204, `LS[A]={LC:1002}` | — | — | 204 | — |
| 1 | User clicks A | 204 | 1004 | 204 | `CL=[...SD[A]]`; `LC = LS[A].LC + (SD[A].length − LS[A].lines.length) = 1002+2 = 1004`; no HTTP fetch |

### Close tab while streaming

| Step | Event | CL | LC | LS | Action |
|---|---|---|---|---|---|
| 0 | Streaming | 202 | 1002 | stale | — |
| 1 | `beforeunload` | 202 | 1002 | — | `saveCurrentCache()` → `LS={lines:202, LC:1002}` |

`LC=1002` not `CL.length=202` — correct because `CL` is a window, not the full file.

### Reopen (page reload)

| Step | Event | CL | LC | Action |
|---|---|---|---|---|
| 0 | `LS` hit: `{lines:202, LC:1002}` | 0 | 0 | — |
| 1 | Apply cache | 202 | 1002 | `applyHistoryLines(LS.lines)` |
| 2a | Fetch `?offset=1002` → `{totalLines:1002, lines:[]}` | 202 | 1002 | Cache fresh, no change |
| 2b | Fetch `?offset=1002` → `{totalLines:1010, lines:8}` | 210 | 1010 | `CL=[...LS.lines,...8]`, `LC=1010` |
| 2c | Fetch `?offset=1002` → `{totalLines:400, …}` | — | — | `400 < LC=1002` → truncation, full refetch |
| 3 | Full refetch `?limit=200` → `{lines:200, totalLines:400}` | 200 | 400 | Full reset; `startLine=200` |

### Scroll back (load earlier history)

| Step | Event | CL | LC | Action |
|---|---|---|---|---|
| 0 | `startLine = LC−CL.length = 800 > 0` | 202 | 1002 | — |
| 1 | Sentinel fires at 30% mark | 202 | 1002 | Background fetch `?offset=500&limit=300` |
| 2 | `{lines:300, totalLines:1002}` received | 202 | 1002 | — |
| 3 | Prepend + preserve scroll | 502 | 1002 | `CL=[...300,...CL]`; `startLine=1002−502=500`; browser `overflow-anchor` keeps viewport stable (Safari: `$effect.pre`/`$effect` delta) |
| 4 | Re-render | 502 | 1002 | `applyLines(CL.slice(findBoundary(CL)))` |
| 5 | Sentinel fires again | 502 | 1002 | `startLine=500 > 0`; fetch `?offset=200&limit=300` |
| 6 | `startLine` reaches 0 | — | — | Sentinel disabled — at beginning of file |

### File on disk truncated

| Step | Event | CL | LC | Action |
|---|---|---|---|---|
| 0 | `LS={lines:202, LC:1002}` applied | 202 | 1002 | — |
| 1 | Fetch `?offset=1002` → `{totalLines:400, lines:[], incremental:true}` | 202 | 1002 | `400 < 1002` → truncation detected |
| 2 | Full refetch `?limit=200` → `{lines:200, totalLines:400}` | 200 | 400 | Drop old cache; full reset |

---

## Lifecycle Sequences

### Cold start — no agents running
```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant H as Host
    participant Cl as Claude
    C->>S: WS open
    C->>S: list_sessions (WS)
    S->>H: list_sessions
    H-->>S: session_list
    S-->>C: session_list
    Note over C: pick most recent session
    C->>+S: GET /api/sessions/:id/history?offset=0
    S-->>-C: {lines, incremental:false}
    Note over C: display + cache in localStorage
    C->>+S: user (WS)
    Note over C: send button - pending indicator
    S->>+H: user
    S-->>-C: (forwarded)
    H->>+Cl: spawn --resume id
    Cl-->>H: system.init
    H-->>S: agent_event(started)
    S-->>C: agent_event(started)
    H->>Cl: stdin write
    H-->>-S: claude_line(user echo)
    S-->>C: claude_line(user echo)
    Note over C: pending cleared - message bubble rendered
    loop streaming
        Cl-->>H: stdout line
        H-->>S: claude_line
        S-->>C: claude_line
    end
    Cl-->>-H: result
```

### Hot start — agent running, client reconnects
```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant H as Host
    Note over C: show localStorage cache immediately
    C->>S: WS open
    C->>S: list_sessions (WS)
    S->>H: list_sessions
    H-->>S: session_list
    S-->>C: session_list
    C->>+S: GET /sessions/:id/history?offset=N
    S-->>-C: {lines: newLines, incremental:true}
    Note over C: merge new lines into cache
    S-->>C: claude_line (already in flight)
```

### Session switch
```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    C->>S: GET /sessions/B/history
    S-->>C: {lines}
    Note over C: claude_line(A) still arrives via WS, stored in A store, B rendered
```

### Two clients — one session active, one joining
```mermaid
sequenceDiagram
    participant A as ClientA
    participant B as ClientB
    participant S as Server
    participant H as Host
    Note over A,S: ClientA connected, viewing session A, agent running
    B->>S: WS open
    B->>S: list_sessions (WS)
    S->>H: list_sessions
    H-->>S: session_list
    S-->>B: session_list
    B->>+S: GET /sessions/A/history
    S-->>-B: {lines}
    A->>+S: user (WS)
    Note over A: send button - pending indicator
    S->>+H: user
    S-->>-A: (forwarded)
    H-->>-S: claude_line(A, user echo)
    S-->>A: claude_line(A, user echo)
    S-->>B: claude_line(A, user echo)
    Note over A: pending cleared - message bubble rendered
    loop streaming, both clients viewing A
        H-->>S: claude_line(A)
        S-->>A: claude_line(A)
        S-->>B: claude_line(A)
    end
    Note over B: switches to session B
    B->>S: GET /sessions/B/history
    S-->>B: {lines}
    loop streaming, B viewing B, A still running
        H-->>S: claude_line(A)
        S-->>A: claude_line(A)
        S-->>B: claude_line(A)
        Note over B: stored in A store, B rendered
    end
    Note over B: deletes session C
    B->>S: DELETE /sessions/C
    S->>H: delete_session
    H-->>S: session_list
    S-->>B: 204
    S-->>A: session_list
    S-->>B: session_list
    Note over A,B: both sidebars drop C
```

### Interrupt then stop
```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant H as Host
    C->>S: agent_ctl(interrupt) WS
    S->>+H: agent_ctl(interrupt)
    Note over H: SIGUSR1
    H-->>-S: agent_event(idle)
    S-->>C: agent_event(idle)
    C->>S: agent_ctl(stop) WS
    S->>+H: agent_ctl(stop)
    Note over H: proc.kill()
    H-->>-S: agent_event(stopped)
    S-->>C: agent_event(stopped)
    S-->>C: session_list
```
