<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { messages, lastCost, lastUsage, hostStatus, wsOk, highContrast,
           sessions, currentSessionId, sessionData } from '../store.js';
  import { toolSummary } from '../utils/tools.js';
  import MessageList from './MessageList.svelte';
  import ChatInput from './ChatInput.svelte';
  import SessionSidebar from './SessionSidebar.svelte';
  export let token;
  const dispatch = createEventDispatcher();

  let ws;
  let msgCounter = 0;
  const uid = () => ++msgCounter;

  let sidebarOpen = true;
  let hostCwd = null;
  let currentLines = [];       // raw jsonl lines for current session (for cache writes)
  let awaitingNewSession = false; // auto-switch on next agent_event: started
  let pendingCwd = null;         // cwd for the pending __new__ session

  // per-turn tracking (always for the active session)
  let seenToolIds = new Set();
  let liveClaudeId = null;  // ev.message.id of the assistant message being streamed
  let liveUid = null;       // our messages[] id for that row

  // Derived: is the current session's agent active?
  $: currentAgentActive = !!$sessions.find(s => s.id === $currentSessionId)?.agentState;

  onMount(async () => {
    sidebarOpen = window.innerWidth > 640;
    window.addEventListener('beforeunload', saveCurrentCache);
    await initSessions();
    connect();
  });
  onDestroy(() => {
    window.removeEventListener('beforeunload', saveCurrentCache);
    ws?.close();
  });

  // ── Startup: load sessions, pick most recent, load history, then connect WS ──

  async function initSessions() {
    let sessionList = [];
    try {
      const res = await fetch('/api/sessions', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        sessionList = data.sessions ?? data;
        if (data.hostCwd) hostCwd = data.hostCwd;
        sessions.set(sessionList);
      }
    } catch (e) {
      // network error — will retry via WS
    }

    if (sessionList.length === 0) return;

    // Pick most recent (index 0, server returns desc by ts)
    const first = sessionList[0];
    currentSessionId.set(first.id);
    await loadSessionHistory(first.id);
  }

  // ── localStorage cache ───────────────────────────────────────────────────────
  // Format: { lines: string[], lineCount: number }
  // Incremental fetch uses ?offset=lineCount — host returns raw.slice(offset).
  // No clock comparison needed; line count is always correct and monotonically grows.

  function saveCurrentCache() {
    const id = $currentSessionId;
    if (!id || currentLines.length === 0) return;
    try {
      localStorage.setItem('history_' + id, JSON.stringify({
        lines: currentLines,
        lineCount: currentLines.length,
      }));
    } catch {}
  }

  async function loadSessionHistory(id) {
    if (!id || id === '__new__') return;
    const cacheKey = 'history_' + id;
    let cached = null;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        cached = JSON.parse(raw);
        if (!('lineCount' in cached)) cached = null; // discard old format
      }
    } catch {}

    // Show cached lines immediately for instant display
    if (cached) applyHistoryLines(cached.lines);

    // Always fetch to pick up any new lines since cache was written
    await fetchAndApplyHistory(id, cached, cacheKey);
  }

  async function fetchAndApplyHistory(id, cached, cacheKey) {
    try {
      const offset = cached ? cached.lineCount : null;
      const params = offset ? `?offset=${offset}` : '';
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/history${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const lines = data.lines ?? [];

      if (data.incremental && cached) {
        if (lines.length === 0) return; // nothing new, cache already displayed
        const merged = [...cached.lines, ...lines];
        applyHistoryLines(merged);
        try { localStorage.setItem(cacheKey, JSON.stringify({ lines: merged, lineCount: merged.length })); } catch {}
      } else {
        applyHistoryLines(lines);
        try { localStorage.setItem(cacheKey, JSON.stringify({ lines, lineCount: lines.length })); } catch {}
      }
    } catch {}
  }

  function applyHistoryLines(lines) {
    currentLines = [...lines];
    messages.set([]);
    resetTurnState();
    for (const line of lines) parseLine(line, false);
    finalizeIncomplete();
  }

  // ── WebSocket ────────────────────────────────────────────────────────────────

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen  = () => wsOk.set(true);
    ws.onclose = () => { wsOk.set(false); setTimeout(connect, 3000); };
    ws.onerror = () => {};
    ws.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'session_list') {
        sessions.set(msg.sessions ?? []);
        if (msg.hostCwd) hostCwd = msg.hostCwd;
      }
      else if (msg.type === 'claude_line') {
        const { sessionId, line } = msg;
        if (sessionId === $currentSessionId) {
          currentLines.push(line);
          parseLine(line, true);
        } else {
          // Store in background session cache
          if (!sessionData.has(sessionId)) sessionData.set(sessionId, []);
          // We keep raw lines in background; when switching we replay full history anyway
          // But to keep live accumulation useful we store parsed messages.
          // Since we don't want to parse without a turn-state per session, buffer raw lines.
          sessionData.get(sessionId).push(line);
        }
      }
      else if (msg.type === 'agent_event') {
        const { sessionId, event } = msg;
        const agentState = event === 'idle' ? 'idle'
                         : (event === 'started' || event === 'streaming') ? 'running'
                         : null;
        sessions.update(list => list.map(s =>
          s.id === sessionId ? { ...s, agentState } : s
        ));
        if (awaitingNewSession && event === 'started' && sessionId !== $currentSessionId) {
          awaitingNewSession = false;
          switchSession(sessionId);
        }
      }
      else if (msg.type === 'host_status') {
        hostStatus.set(msg.connected ? 'connected' : 'disconnected');
        if (!msg.connected) { finalizeIncomplete(); }
      }
    };
  }

  // ── Turn state helpers ───────────────────────────────────────────────────────

  function resetTurnState() {
    seenToolIds = new Set(); liveClaudeId = null; liveUid = null;
  }

  function finalizeIncomplete() {
    if (liveUid !== null) {
      messages.update(ms => ms.map(m => m.id === liveUid ? { ...m, streaming: false } : m));
    }
    messages.update(ms => ms.map(m => m.running ? { ...m, running: false } : m));
    resetTurnState();
  }

  function commitTool(b) {
    if (b.name === 'AskUserQuestion') {
      messages.update(ms => [...ms, {
        id: uid(), role: 'user_question',
        toolId: b.id, questions: b.input?.questions ?? [],
      }]);
    } else if (b.name === 'TodoWrite') {
      messages.update(ms => [...ms, {
        id: uid(), role: 'todo',
        toolId: b.id, todos: b.input?.todos ?? [],
      }]);
    } else {
      messages.update(ms => [...ms, {
        id: uid(), role: 'tool',
        toolId: b.id, name: b.name,
        input: b.input, summary: toolSummary(b.name, b.input),
        running: true,
      }]);
    }
  }

  function parseLine(line, live = false) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }

    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      // If this is a new session we don't know about yet, update currentSessionId
      if (!$currentSessionId) currentSessionId.set(ev.session_id);
      return;
    }

    if (ev.type === 'user') {
      const content = ev.message?.content;
      if (typeof content === 'string' && content.trim())
        messages.update(ms => [...ms, { id: uid(), role: 'user', text: content, ts: ev.timestamp ?? null }]);
      return;
    }

    if (ev.type === 'user_message') {
      messages.update(ms => [...ms, { id: uid(), role: 'user', text: ev.text, ts: ev.timestamp ?? null }]);
      return;
    }

    if (ev.type === 'tool') {
      const ids = (ev.content ?? [])
        .filter(b => b.type === 'tool_result')
        .map(b => b.tool_use_id);
      if (ids.length) messages.update(ms => ms.map(m =>
        m.role === 'tool' && ids.includes(m.toolId) ? { ...m, running: false } : m
      ));
      return;
    }

    if (ev.type === 'assistant') {
      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      const claudeId = ev.message?.id ?? null;

      let text = '';
      for (const b of content) {
        if (b.type === 'text') text += b.text;
      }

      if (text) {
        if (claudeId && claudeId === liveClaudeId && liveUid !== null) {
          messages.update(ms => ms.map(m =>
            m.id === liveUid ? { ...m, text } : m
          ));
        } else {
          if (liveUid !== null) {
            messages.update(ms => ms.map(m =>
              m.id === liveUid ? { ...m, streaming: false } : m
            ));
          }
          liveClaudeId = claudeId;
          liveUid = uid();
          messages.update(ms => [...ms, { id: liveUid, role: 'assistant', text, streaming: live, ts: ev.timestamp ?? null }]);
        }
      }

      for (const b of content) {
        if (b.type === 'tool_use' && !seenToolIds.has(b.id)) {
          seenToolIds.add(b.id);
          commitTool(b);
        }
      }

    } else if (ev.type === 'result') {
      if (liveUid !== null) {
        messages.update(ms => ms.map(m =>
          m.id === liveUid ? { ...m, streaming: false } : m
        ));
        liveUid = null;
        liveClaudeId = null;
      }
      messages.update(ms => ms.map(m =>
        m.role === 'tool' && m.running ? { ...m, running: false } : m
      ));
      if (ev.total_cost_usd != null) lastCost.set(ev.total_cost_usd);
      if (ev.usage != null) lastUsage.set(ev.usage);
      seenToolIds = new Set();
    }
  }

  // ── Session switching ────────────────────────────────────────────────────────

  async function switchSession(id) {
    if (id === $currentSessionId) return;

    // Persist current session's lines to localStorage before switching
    saveCurrentCache();

    // Save raw lines to in-memory cache (background handler also pushes raw lines here)
    if ($currentSessionId) sessionData.set($currentSessionId, [...currentLines]);

    currentSessionId.set(id);
    currentLines = [];
    messages.set([]);
    resetTurnState();

    // Quick restore from in-memory raw-line cache (replay is fast, avoids type mismatch)
    const cached = sessionData.get(id);
    if (cached?.length > 0) {
      for (const line of cached) parseLine(line, false);
      currentLines = [...cached];
    }

    await loadSessionHistory(id);
  }

  // ── Slash commands ───────────────────────────────────────────────────────────

  function sysMsg(text) {
    messages.update(ms => [...ms, { id: uid(), role: 'system', text }]);
  }

  function handleSlash(text) {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/clear':
        messages.set([]); lastCost.set(null);
        resetTurnState();
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'clear' }));
        return true;
      case '/status': {
        let h, w;
        hostStatus.subscribe(v => h = v)();
        wsOk.subscribe(v => w = v)();
        sysMsg(`host: ${h}  ·  websocket: ${w ? 'connected' : 'disconnected'}`);
        return true;
      }
      case '/usage':
      case '/context': {
        let c, u;
        lastCost.subscribe(v => c = v)();
        lastUsage.subscribe(v => u = v)();
        const lines = [];
        if (u) {
          const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
          lines.push(`tokens  in:${u.input_tokens ?? '?'}  out:${u.output_tokens ?? '?'}  total:${total}`);
          if (u.cache_read_input_tokens) lines.push(`cache read: ${u.cache_read_input_tokens}`);
          if (u.cache_creation_input_tokens) lines.push(`cache write: ${u.cache_creation_input_tokens}`);
        }
        if (c != null) lines.push(`cost: $${c.toFixed(4)}`);
        sysMsg(lines.length ? lines.join('  ·  ') : 'no usage data yet — complete a turn first');
        return true;
      }
      case '/btw':
        if (arg && ws?.readyState === 1)
          ws.send(JSON.stringify({
            type: 'user',
            sessionId: $currentSessionId,
            message: { role: 'user', content: arg },
          }));
        return true;
      default:
        return false;
    }
  }

  // ── Send ─────────────────────────────────────────────────────────────────────

  async function onSend(e) {
    const text = e.detail;
    if (text.startsWith('/') && handleSlash(text)) return;

    if ($currentSessionId === '__new__') {
      // Set flag BEFORE the POST — agent_event: started can arrive before HTTP response
      awaitingNewSession = true;
      try {
        await fetch('/api/sessions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: pendingCwd, firstMessage: text }),
        });
      } catch { awaitingNewSession = false; }
      return;
    }

    if (ws?.readyState !== 1) return;
    // Do NOT optimistically add — server echoes as claude_line immediately
    ws.send(JSON.stringify({
      type: 'user',
      sessionId: $currentSessionId,
      message: { role: 'user', content: text },
    }));
  }

  // ── Sidebar event handlers ───────────────────────────────────────────────────

  function onResume(e) {
    const id = e.detail;
    switchSession(id);
    if (window.innerWidth <= 640) sidebarOpen = false;
  }

  function onNewSession(e) {
    pendingCwd = e.detail || null;
    saveCurrentCache();
    currentSessionId.set('__new__');
    currentLines = [];
    messages.set([]);
    resetTurnState();
    if (window.innerWidth <= 640) sidebarOpen = false;
  }

  async function onDelete(e) {
    const id = e.detail;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      // Server broadcasts updated session_list — no need to update locally
    } catch {}
  }

  function onAgentCtl(e) {
    const { id, event } = e.detail;
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'agent_ctl', sessionId: id, event }));
    }
  }

  // ── Derived UI state ─────────────────────────────────────────────────────────

  $: inputDisabled = !$wsOk;
  $: inputPlaceholder = $currentSessionId === '__new__'
    ? 'Type your first message to start the session…'
    : !$wsOk
      ? 'Connecting…'
      : $hostStatus !== 'connected'
        ? 'Waiting for host…'
        : currentAgentActive
          ? 'Message Claude… (/ for commands)'
          : 'Send to start… (/ for commands)';
</script>

<div class="layout">
  <header>
    <button class="sidebar-toggle" on:click={() => sidebarOpen = !sidebarOpen}
      title="Toggle sessions" aria-pressed={sidebarOpen}>☰</button>
    <span class="brand">claude</span>
    <div class="indicators">
      <span class="dot" class:on={$hostStatus === 'connected'}>host</span>
      <span class="dot" class:on={$wsOk}>ws</span>
      <span class="dot ai" class:on={currentAgentActive}>ai</span>
      {#if $lastCost != null}
        <span class="cost">${$lastCost.toFixed(4)}</span>
      {/if}
    </div>
    <button class="hc-toggle" on:click={() => highContrast.update(v => !v)}
      title="Toggle high contrast" aria-pressed={$highContrast}>HC</button>
    <button class="logout" on:click={() => dispatch('logout')}>logout</button>
  </header>

  <div class="body">
    {#if sidebarOpen}
      <div class="backdrop" on:click={() => sidebarOpen = false} aria-hidden="true"></div>
    {/if}
    <SessionSidebar
      sessions={$sessions}
      currentId={$currentSessionId}
      open={sidebarOpen}
      {hostCwd}
      on:resume={onResume}
      on:delete={onDelete}
      on:new_session={onNewSession}
      on:agent_ctl={onAgentCtl}
    />
    <div class="chat">
      <MessageList hostStatus={$hostStatus} />
      <ChatInput
        disabled={inputDisabled}
        placeholder={inputPlaceholder}
        sendLabel={currentAgentActive ? 'send' : 'send & start'}
        on:send={onSend}
      />
    </div>
  </div>
</div>

<style>
  .layout { display: flex; flex-direction: column; height: var(--app-height, 100dvh); }
  .body { display: flex; flex: 1; overflow: hidden; position: relative; }
  .chat { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

  .backdrop { display: none; }
  @media (max-width: 640px) {
    .backdrop {
      display: block;
      position: absolute; inset: 0; z-index: 40;
      background: rgba(0,0,0,.35);
    }
  }

  header {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 16px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .sidebar-toggle {
    background: none; border: none; color: var(--text-dim);
    cursor: pointer; font: inherit; font-size: 1rem;
    padding: 0 4px; line-height: 1; flex-shrink: 0;
  }
  .sidebar-toggle:hover { color: var(--text-muted); }
  .sidebar-toggle[aria-pressed="true"] { color: var(--accent); }
  .brand { color: var(--accent); font-weight: 600; font-size: .88rem; flex: 1; }
  .indicators { display: flex; align-items: center; gap: 8px; }
  .dot { font-size: .72rem; color: var(--text-dim); }
  .dot.on { color: #5a5; }
  .dot.ai.on { color: var(--accent-light); }
  .cost { font-size: .72rem; color: var(--text-dim); }
  .logout {
    background: none; border: none; color: var(--text-dim);
    cursor: pointer; font: inherit; font-size: .72rem; padding: 0;
  }
  .logout:hover { color: var(--text-muted); }
  .hc-toggle {
    background: none; border: 1px solid var(--border); color: var(--text-dim);
    cursor: pointer; font: inherit; font-size: .72rem;
    padding: 2px 6px; border-radius: 4px; transition: color .15s, border-color .15s;
  }
  .hc-toggle[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }
  .hc-toggle:hover { color: var(--text-muted); border-color: var(--text-muted); }
</style>
