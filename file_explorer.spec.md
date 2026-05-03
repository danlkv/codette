# File Explorer

Sidebar subsection below the session list. Shows the directory tree rooted at the current
session's `cwd`. Clicking a file replaces the chat area with a read-only file viewer.

---

## UI

### Sidebar — FileExplorer component

- Rendered below the session list in `SessionSidebar.svelte`, collapsible.
- Header: `Files  <cwd-basename>` with collapse toggle.
- Tree nodes: directories (▶/▼ toggle) and files (click to open).
- Lazy loading: only fetch one directory level at a time on expand.
- Root is fetched automatically when the section is expanded or current session changes.
- No root shown (and section hidden) when session has no `cwd`.

```
▼ Files  myproject
  ▶ src
  ▶ tests
    README.md
    package.json
```

### Main area — FileView mode

When a file is selected, the chat area is replaced by a file viewer:
- Header bar: `<relative-path>  ×` (close returns to chat).
- Content rendered in `<pre>` with horizontal scroll; no syntax highlighting for now.
- If file is binary (read error or content contains null bytes), show `[binary file]`.
- Max display size: 512 KB — larger files show `[file too large to display]`.

---

## Protocol additions

### Layer 2 — Host ↔ Server

**Server → Host**

| type | key fields | notes |
|------|-----------|-------|
| `get_fs` | `sessionId`, `path` | list directory at `path` (absolute); host uses session's cwd as base if path empty |
| `get_file` | `sessionId`, `path` | read file at absolute `path` |

**Host → Server**

| type | key fields | notes |
|------|-----------|-------|
| `fs_result` | `sessionId`, `path`, `entries: Entry[]` | directory listing |
| `file_result` | `sessionId`, `path`, `content: string \| null`, `error?: string` | file content; `null` = binary/too large |

**Entry object:**
```json
{ "name": "string", "path": "/absolute/path", "isDir": true }
```
Entries sorted: directories first, then files, both alphabetically.

### Layer 3 — Server ↔ Client (REST)

| method | path | query | response | notes |
|--------|------|-------|----------|-------|
| `GET` | `/api/sessions/:id/fs` | `path=<abs>` | `{ entries: Entry[] }` | list directory; omit `path` to list session cwd |
| `GET` | `/api/sessions/:id/file` | `path=<abs>` | `{ content: string } \| { error: string }` | read file; 400 if path outside session cwd |

Both endpoints park the HTTP response in a pending map and forward to host via WS, same
pattern as `get_session_history`.

**Security:** host validates that `path` is under the session's `cwd` before reading.

---

## Server internal state

```
pendingFsHttp:   Map<key, res>   // key = sessionId + ':' + path
pendingFileHttp: Map<key, res>   // key = sessionId + ':' + path
```

---

## Implementation plan

### Host (`host/index.js`)
1. Handle `get_fs`: `readdirSync(path)`, map to `Entry[]`, send `fs_result`.
2. Handle `get_file`: `readFileSync(path)`, check size ≤ 512 KB, check for null bytes,
   send `file_result`. Catch errors → `{ content: null, error }`.
3. Both handlers: validate path starts with session's `cwd` (use `getSessionCwd`).

### Server (`server/src/index.js`)
1. Add `pendingFsHttp` and `pendingFileHttp` maps.
2. `GET /api/sessions/:id/fs` → park res, send `get_fs` to host.
3. `GET /api/sessions/:id/file` → park res, send `get_file` to host.
4. Handle `fs_result` / `file_result` from host → drain pending maps.
5. Add 30 s timeout guards (same as history).

### Client
1. `FileExplorer.svelte` — tree component, fetches on expand, emits `file-open` event.
2. `FileView.svelte` — `<pre>` viewer with close button, fetches file content on mount.
3. `SessionSidebar.svelte` — add `<FileExplorer>` below list, pass `sessionCwd` and `sessionId`.
4. `ChatLayout.svelte` — add `fileViewPath` state; show `<FileView>` instead of `<MessageList>` when set.
5. `store.js` — `sessionCwd` derived store already exists.
