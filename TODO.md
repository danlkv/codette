# TODO

## Bugs

1. Question tool not supported in `--json` mode — remove it or figure out how to support.
2. WebSocket status reported as inactive if host is inactive at start.
3. [x] First message in a new session is not displayed in the client UI.
4. [x] Host crashes if the directory for a new session does not exist.
5. ExitPlanMode is silently rejecting in `--json` mode.
6. [x] Page reload does not reopen the active chat.
7. Logout does not clear cached data.
8. Messages routed to wrong session — resume returns a different session ID.
9. Client page loads delayed while agent is thinking.
10. New chat: textbox clears before message appears in chat history.
11. htmlrender iframe auto-resize feedback loop with viewport-relative CSS (100dvh, 100vh). `body.offsetHeight` matches viewport → parent sets same height → body re-measures → +1 drift in some cases. Possible fix: detect viewport-unit usage and use fixed height with internal scroll instead of auto-resize.

## Enablers & Blockers
Unblock workflows that are not possible today.

1. File access & iteration
Theme: no fast path to open or revisit files — every access goes through the tree or message scroll.
   1. [x] HTML rendering in FileView
      - Render `.html` files as an iframe instead of source.
      - Toggle between live preview and source view.
      - Also renders in InlineFile (sourcefile blocks) for `.html` files.
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

7. Message subthreads
Theme: side questions and clarifications derail the main turn — no branching.
   - Slack-style thread panel per message.
   - Mobile: tap message opens the thread. Desktop: hover message → thread icon → click.
   - Subthread messages stay out of main conversation history (side-channel, not injected).
   - Persisted per-message; unread indicator on the parent message.
   - Depends on the sub-message evolution from Polish #11 — a "message" needs a stable boundary to hang a thread off.

5. [x] E2E encryption & device trust
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

3. [x] Git status & commit summary
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

6. [x] Session renaming
Theme: session list shows only AI-generated slugs — no way to label sessions by purpose.
   - Inline rename on double-click or via context menu.
   - Persisted per-session.

7. [x] Syntax theme auto-switching
Theme: highlight theme stays fixed regardless of system light/dark mode.
   - Map each theme to a light/dark variant pair; switch on `prefers-color-scheme` change.

8. Workspace support
Theme: session list grows unbounded with no grouping.
   - Sibling tab "Workspaces" in sidebar. Groups sessions by working directory.

9. [x] Incremental chat loading
Theme: long sessions parse and render the full history on every load, causing lag.
   - On open, render only from the last summarization boundary (or last N messages).
   - Load earlier history on scroll-to-top.

10. Fullscreen file viewer with rendering caps
Theme: large or repeatedly-edited files bloat the chat and have no dedicated view.
   - Fullscreen toggle for file content (like the existing mermaid fullscreen) — code, HTML preview, etc.
   - HTML rendering caps: truncate or collapse inline file content beyond a threshold.
   - When Claude edits the same HTML file multiple times, prefer inline file attachment over repeated full dumps.

11. Keyboard navigation
Theme: no fast way to skim a long session — mouse scroll only.
   - `K` / `J` (capital) jump to prev / next message boundary.
   - Depends on sub-messages — an evolution of the existing message unit: long assistant turns split so boundaries land ~one screen apart.
     - Auto-split: paragraph/heading boundary nearest viewport-height threshold.
     - Alternative behind a feature flag: prompt the agent to emit an explicit divider fence (e.g. ```` ```divider ````).
