# TODO

## Bugs

1. Question tool not supported in `--json` mode — remove it or figure out how to support.
2. WebSocket status reported as inactive if host is inactive at start.
3. First message in a new session is not displayed in the client UI.
4. Host crashes if the directory for a new session does not exist.

## Enablers & Blockers
Unblock workflows that are not possible today.

1. File access & iteration
Theme: no fast path to open or revisit files — every access goes through the tree or message scroll.
   1. HTML rendering in FileView
      - Render `.html` files as an iframe instead of source.
      - Should be as simple as setting `src` to a blob URL or data URI.
      - Enables in-app iteration on design prototypes (e.g. ctx-designs.html).
   2. File reload on update
      - Detect when an open file changes on disk and reload automatically.
   3. Recently used files + pinned files
      - Per-session. Storage: pinned list + 5-entry LRU.
      - Display location options:
        - **A**: sidebar, near the file explorer section
        - **B**: tabbar above the chatbox — boxes per file. `-` icon minimizes (hides panel) instead of closing. On mobile: one-tap toggle.
        - **C**: hybrid — A for LRU, B for pinned

2. Codex support
Theme: tool only works with Claude Code sessions — Codex users have no viewer.
   - Parse OpenAI Codex CLI session format and map to the internal event schema.

3. Mobile push notifications
Theme: no way to know when a long-running session finishes without keeping the tab open.
   - Send a push notification when a session result arrives.
   - Requires a service worker + Push API; server sends notification on session `result` event.

4. Cross-session search
Theme: finding a past message or decision requires scrolling through individual sessions.
   - Search bar over all sessions; results show session + message snippet.
   - Server-side search endpoint; no client-side indexing required.

6. Conversation sharing
Theme: no way to show someone a session without giving them account access.
   - Server generates a signed share token for a session or a specific message range.
   - Share link opens a view-only render — no auth required, no input controls.
   - Expiry and revocation controlled by the owner.

5. E2E encryption & device trust
Theme: the server is a relay — it sees all session traffic in plaintext, so a compromised relay exposes full history.
   - Encrypt messages on the client before sending; decrypt on receive — relay sees only ciphertext.
   - Device pairing flow to share keys across devices.
   - Device revocation invalidates a device's key without re-keying others.
   - Periodic biometric re-authentication (Face ID / fingerprint) gates decryption.

## Polishes
Improve existing workflows. Nothing is blocked without these.

1. Summarization messages
Theme: no landmark for where context was reset.
   - Distinguish summarization events in the message list (visual separator or badge).
   - Allow scrolling/jumping to last summarization point.

2. [x] Files in context
Theme: choosing the right session requires opening each one to infer its state.
   - Display files read since the last summarization, shown as chips on each session list entry.

3. Git status & commit summary
Theme: sidebar shows git log but not unstaged changes or commit-level file summaries.
   - Show unstaged changes (modified/untracked files) alongside the git log.
   - Display a file-level summary in commit view: filename + lines added/removed.

4. Subagent & background task visibility
Theme: subagents and background tasks run but leave no trace in the UI.
   - Show active/completed subagents inline in the message stream.
   - Indicate background task status (running, done, failed) without requiring message scroll.

5. PDF viewer
Theme: PDF re-renders fully on each zoom step, causing lag; no dark mode invert.
   - Debounce or cancel in-flight renders on rapid zoom changes.
   - Add invert mode (CSS filter) for dark-background reading.

6. Session renaming
Theme: session list shows only AI-generated slugs — no way to label sessions by purpose.
   - Inline rename on double-click or via context menu.
   - Persisted per-session.

7. [x] Syntax theme auto-switching
Theme: highlight theme stays fixed regardless of system light/dark mode.
   - Map each theme to a light/dark variant pair; switch on `prefers-color-scheme` change.

8. Workspace support
Theme: session list grows unbounded with no grouping.
   - Sibling tab "Workspaces" in sidebar. Groups sessions by working directory.

9. Incremental chat loading
Theme: long sessions parse and render the full history on every load, causing lag.
   - On open, render only from the last summarization boundary (or last N messages).
   - Load earlier history on scroll-to-top.
