# Inline File Viewer

Agent quotes source files inline in chat. The UI renders a scrollable file panel instead of
pasting raw code. Agent learns the syntax from an appended system prompt.

---

## Agent syntax

Agent emits a `sourcefile` code fence in its text response:

````
```sourcefile
/absolute/or/relative/path/to/file.js:10-50
```
````

With multiple ranges and annotations:

````
```sourcefile
/path/to/file.py:80-120,145,160-180
@80 entry point
@145 off-by-one bug
@160 called on every tick — expensive
```
````

- Path may be absolute or relative to session cwd.
- After `:` is a comma-separated list of line ranges. Each range is `N` (single line) or `N-M`.
- All specified lines are highlighted (blue tint) in the panel.
- The view window covers all specified ranges plus context padding (up to 600 lines total).
- **Order is preserved** — the UI's prev/next range navigation follows the agent-specified sequence,
  so the agent can encode a meaningful traversal order (e.g. `:100,10,50` visits 100 → 10 → 50 → wrap).
- Keep total span under **800 lines** to avoid overflow.
- Omit `:` entirely to show the whole file with no highlights.
- **Annotations**: optional `@N text` lines after the path line attach inline notes rendered as
  virtual text at end-of-line (dim italic, non-selectable). Any line number may be annotated,
  not just highlighted ones.
- **Annotations are static** — they are baked into the message at render time and do not update
  if the file changes on disk. Line numbers may drift after edits. The agent should re-emit a
  fresh `sourcefile` fence if the file has changed since the annotation was written.

#### Loading state
Viewport holds `min-height: 30vh` while fetching to prevent layout shift; collapses to content height after load.

#### Staleness detection (implemented: mtime)

`/api/sessions/:id/file` returns `{ content, mtime }` (mtime in ms). Client compares `mtime`
to `message.ts` (ms, set from `ev.timestamp` ISO string or `Date.now()` at stream start); if
`mtime > messageTime` and annotations are present, shows a dim `⚠ file modified` warning in
the header.

Alternative not implemented: **first-load hash** — on first fetch store trimmed line content in
`localStorage` keyed by `sessionId:path:lineNum`; compare on subsequent fetches for
per-annotation drift detection.

### Verified behaviour

Experiment (2026-05-05): `--append-system-prompt` with the 3-line instruction below, prompt
"show me the docker-compose.yml file" → Claude ran `Glob` to find the file, then responded
with a correct `sourcefile` fence and no raw code dump. Uses full absolute path by default.

---

## System prompt injection

Host appends to every new session via `--append-system-prompt` flag in `spawnClaude()`:

````
This chat renders a special code fence as an interactive scrollable file panel:
```sourcefile
path/to/file:10-50,95,100-110
```
Use this instead of pasting raw code whenever you reference an existing file. After `:` is a
comma-separated list of line ranges — each range is `N` or `N-M`. All specified lines are
highlighted and the view window covers them all. Keep the total span under 800 lines. Order is
preserved and drives the prev/next navigation buttons, so you can encode a meaningful traversal
sequence. Omit the `:` spec entirely to show the whole file with no highlights.
````

---

## UI

### Rendered block

Replaces the `sourcefile` fence inside any assistant message:

```
┌─ 📄 src/lib/MessageBubble.svelte:45–80,95 ──────── [1/2] [copy path] ─┐
│  45  <script>                                                            │
│  46    import { renderMd } from '../utils/markdown.js';                 │
│  ...                                                                     │
│ ▶52    <div class="prose">                                    ← hl      │
│  ...                                                                     │
│  80  </script>                                                           │
│ ▶95    export default Component;                              ← hl      │
└──────────────────────────────────────────────────────────────────────────┘
```

- Fixed height (~30vh), vertically scrollable.
- Line numbers shown left of content.
- All lines within any specified range have a blue highlight tint.
- Header shows path + range spec.
- Prev/next buttons (↑/↓) shown when there are 2+ ranges; navigate in agent-specified order.
- "copy path" button copies the absolute path to clipboard.
- "view file" button (when available) opens the full file in the fullscreen viewer.
- Collapse/expand toggle (▼/▶) in header.
- Auto-scrolls to first range on mount.
- If file fetch fails: show `[could not load: <error>]` inside the panel.

### Enabling for a new session

Checkbox in the `showNew` form in the sessions sidebar, alongside the cwd input:

```
[/path/to/project        ] [Start]
[✓] instruct agent to use inline file viewer
```

Stored in `localStorage` as the default for future sessions.

### Enabling for an existing session — `/inline-files`

Slash command available in the input bar of any active session. Sends `INLINE_FILE_PROMPT`
as a user message to Claude's stdin, then shows a dim system notice in the UI:
`inline file viewer enabled`.

One-way only — the instruction enters conversation history and cannot be cleanly retracted.

---

## Implementation

### `markdown.js` — `sourcefile` renderer

```js
renderer.code(token) {
  if (token.lang === 'sourcefile') {
    const line = token.text.trim();
    const colonIdx = line.lastIndexOf(':');
    const hasRanges = colonIdx > 0 && /^\d/.test(line.slice(colonIdx + 1));
    const filePath = hasRanges ? line.slice(0, colonIdx) : line;
    const ranges = hasRanges ? line.slice(colonIdx + 1) : '';
    return `<div class="source-file-block"
                 data-path="${esc(filePath)}"
                 data-ranges="${esc(ranges)}"></div>`;
  }
}
```

DOMPurify config: `ADD_ATTR: ['aria-hidden', 'data-path', 'data-ranges']`

### `src/utils/sourcefile-action.js`

Parses `data-ranges` string into `Array<{start, end}>` and passes as `ranges` prop to `SourceFileBlock`.

```js
function parseRanges(str) {
  return str.split(',').map(r => {
    const [s, e] = r.split('-');
    return { start: +s, end: e ? +e : +s };
  }).filter(r => r.start > 0);
}
```

### `src/lib/SourceFileBlock.svelte`

Props: `path`, `ranges[]`, `sessionId`, `token`, `onOpenFile`.

- `hlSet`: derived Set of all line numbers within any range (for O(1) highlight check).
- `navTargets`: derived array of `range.start` values in agent-specified order (for ↑/↓ nav).
- View window: `min(range.start) – max(range.end)` + context padding up to `MAX_LINES = 600`.
- IntersectionObserver lazy fetch; in-flight deduplication via module-level Map.

### Performance

IntersectionObserver for lazy loading + in-flight deduplication. The `hlSet` iterates at most
800 lines (enforced by prompt); O(1) lookup during render.

---

## Files changed

| file | change |
|------|--------|
| `host/index.js` | read `settings.inlineFiles`, pass `--append-system-prompt` |
| `server/src/index.js` | forward `settings` in `new_session` to host |
| `shared/prompts.js` | single source of truth for agent prompt |
| `client/src/utils/markdown.js` | `sourcefile` fence renderer, `data-ranges` attr |
| `client/src/lib/MessageBubble.svelte` | `sessionId`+`token`+`onOpenFile` props, `use:sourceFileRender` |
| `client/src/lib/SessionSidebar.svelte` | inline-files checkbox |
| `client/src/lib/ChatLayout.svelte` | `handleNewSession` settings; `/inline-files` handler |
| `client/src/lib/ChatInput.svelte` | `/inline-files` in autocomplete |
| `client/src/utils/sourcefile-action.js` | DOM hydration action, `parseRanges` |
| `client/src/lib/SourceFileBlock.svelte` | file panel component |
