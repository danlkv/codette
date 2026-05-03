<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { messages, lastCost, lastUsage, hostStatus, wsOk, highContrast,
           sessions, currentSessionId, sessionData } from '../store.js';
  import { createParser } from './parser.js';
  import MessageList from './MessageList.svelte';
  import ChatInput from './ChatInput.svelte';
  import SessionSidebar from './SessionSidebar.svelte';
  import FileView from './FileView.svelte';
  import DiffView from './DiffView.svelte';

  let { token, onLogout } = $props();

  const parser = createParser({ messages, currentSessionId, lastCost, lastUsage });

  let ws;
  let sysCounter = 0;

  let sidebarOpen = $state(true);
  let hostCwd = $state(null);
  let fileViewPath = $state(null);
  let diffViewCommit = $state(null);
  let currentLines = [];       // raw jsonl lines for current session (for cache writes)
  let awaitingNewSession = false;
  let pendingCwd = null;

  let currentAgentActive = $derived(!!$sessions.find(s => s.id === $currentSessionId)?.agentState);
  let inputDisabled = $derived(!$wsOk);
  let inputPlaceholder = $derived($currentSessionId === '__new__'
    ? 'Type your first message to start the session…'
    : !$wsOk
      ? 'Connecting…'
      : $hostStatus !== 'connected'
        ? 'Waiting for host…'
        : currentAgentActive
          ? 'Message Claude… (/ for commands)'
          : 'Send to start… (/ for commands)');

  function onPopState() {
    const id = location.hash.slice(1) || null;
    if (!id || id === get(currentSessionId)) return;
    if (id === 'new') { handleNewSession(null); return; }
    switchSession(id);
  }

  onMount(async () => {
    sidebarOpen = window.innerWidth > 640;
    window.addEventListener('beforeunload', saveCurrentCache);
    window.addEventListener('popstate', onPopState);
    await initSessions();
    connect();
  });
  onDestroy(() => {
    window.removeEventListener('beforeunload', saveCurrentCache);
    window.removeEventListener('popstate', onPopState);
    ws?.close();
  });

  const dedupById = arr => [...new Map(arr.map(s => [s.id, s])).values()];

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
        sessions.set(dedupById(sessionList));
      }
    } catch (e) {}

    if (sessionList.length === 0) return;
    const hashId = location.hash.slice(1) || null;
    const target = (hashId && hashId !== 'new' && sessionList.find(s => s.id === hashId))
      ? hashId
      : sessionList[0].id;
    history.replaceState(null, '', '#' + target);
    currentSessionId.set(target);
    await loadSessionHistory(target);
  }

  // Summarize old lines to save space:
  //   - drop tool results (user events with array content)
  //   - truncate assistant text blocks to 500 chars
  //   - truncate Edit tool old_string/new_string to 500 lines
  function summarizeOldLines(lines) {
    return lines.flatMap(line => {
      let ev;
      try { ev = JSON.parse(line); } catch { return [line]; }

      if (ev.type === 'user' && Array.isArray(ev.message?.content)) return [];

      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        let changed = false;
        const content = ev.message.content.flatMap(b => {
          if (b.type === 'thinking') { changed = true; return []; }
          if (b.type === 'text' && b.text.length > 500) {
            changed = true;
            return [{ ...b, text: b.text.slice(0, 500) + `…[+${b.text.length - 500} chars]` }];
          }
          if (b.type === 'tool_use' && b.name === 'Edit' && b.input) {
            let inputChanged = false;
            const input = { ...b.input };
            for (const field of ['old_string', 'new_string']) {
              if (typeof input[field] === 'string') {
                const ls = input[field].split('\n');
                if (ls.length > 500) {
                  input[field] = ls.slice(0, 500).join('\n') + `\n…[+${ls.length - 500} lines]`;
                  inputChanged = true;
                }
              }
            }
            if (inputChanged) { changed = true; return [{ ...b, input }]; }
          }
          return [b];
        });
        return [changed ? JSON.stringify({ ...ev, message: { ...ev.message, content } }) : line];
      }

      return [line];
    });
  }

  // Try to store history; on QuotaExceededError summarize old lines, then evict other
  // sessions, retrying at each step. lineCount is always the real count so server
  // offsets stay correct.
  function tryStoreHistory(cacheKey, lines, lineCount) {
    try { localStorage.setItem(cacheKey, JSON.stringify({ lines, lineCount })); return; }
    catch (e) { if (e.name !== 'QuotaExceededError') { console.error('tryStoreHistory:', e); return; } }

    const KEEP = 500;
    const summarized = lines.length > KEEP
      ? [...summarizeOldLines(lines.slice(0, -KEEP)), ...lines.slice(-KEEP)]
      : summarizeOldLines(lines);

    try { localStorage.setItem(cacheKey, JSON.stringify({ lines: summarized, lineCount })); return; }
    catch (e) { if (e.name !== 'QuotaExceededError') { console.error('tryStoreHistory after summarize:', e); return; } }

    // Evict all other sessions' history caches then retry
    const toEvict = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('history_') && k !== cacheKey) toEvict.push(k);
    }
    toEvict.forEach(k => localStorage.removeItem(k));
    console.warn('tryStoreHistory: evicted', toEvict.length, 'other session(s) to free space');

    try { localStorage.setItem(cacheKey, JSON.stringify({ lines: summarized, lineCount })); }
    catch (e2) { console.error('tryStoreHistory after evict:', e2); }
  }

  function saveCurrentCache() {
    const id = get(currentSessionId);
    if (!id || currentLines.length === 0) return;
    tryStoreHistory('history_' + id, currentLines, currentLines.length);
  }

  async function loadSessionHistory(id) {
    if (!id || id === '__new__') return;
    const cacheKey = 'history_' + id;
    let cached = null;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        cached = JSON.parse(raw);
        if (!('lineCount' in cached)) cached = null;
      }
    } catch (e) { console.error('loadSessionHistory localStorage read:', e); }

    if (cached) applyHistoryLines(cached.lines);
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
        if (lines.length === 0) {
          if (data.totalLines !== undefined && cached.lineCount > data.totalLines) {
            await fetchAndApplyHistory(id, null, cacheKey);
          }
          return;
        }
        const merged = [...cached.lines, ...lines];
        applyHistoryLines(merged);
        tryStoreHistory(cacheKey, merged, merged.length);
      } else {
        applyHistoryLines(lines);
        tryStoreHistory(cacheKey, lines, lines.length);
      }
    } catch (e) { console.error('fetchAndApplyHistory:', e); }
  }

  function applyHistoryLines(lines) {
    currentLines = [...lines];
    messages.set(parser.applyLines(lines));
  }

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
        sessions.set(dedupById(msg.sessions ?? []));
        if (msg.hostCwd) hostCwd = msg.hostCwd;
      }
      else if (msg.type === 'claude_line') {
        const { sessionId, line } = msg;
        if (sessionId === get(currentSessionId)) {
          currentLines.push(line);
          parser.parseLine(line, true);
        } else {
          if (!sessionData.has(sessionId)) sessionData.set(sessionId, []);
          sessionData.get(sessionId).push(line);
        }
      }
      else if (msg.type === 'agent_event') {
        const toState = ev => ev === 'idle' ? 'idle' : (ev === 'started' || ev === 'streaming') ? 'running' : null;
        if (msg.states) {
          sessions.update(list => list.map(s =>
            msg.states[s.id] !== undefined ? { ...s, agentState: toState(msg.states[s.id]) } : s
          ));
        } else {
          const { sessionId, event } = msg;
          sessions.update(list => list.map(s =>
            s.id === sessionId ? { ...s, agentState: toState(event) } : s
          ));
          if (awaitingNewSession && event === 'started' && sessionId !== get(currentSessionId)) {
            awaitingNewSession = false;
            switchSession(sessionId);
          }
        }
      }
      else if (msg.type === 'host_status') {
        hostStatus.set(msg.connected ? 'connected' : 'disconnected');
        if (!msg.connected) { parser.finalizeIncomplete(); }
      }
    };
  }

  async function switchSession(id) {
    if (id === get(currentSessionId)) return;
    history.pushState(null, '', '#' + id);

    fileViewPath = null;
    diffViewCommit = null;
    saveCurrentCache();

    if (get(currentSessionId)) sessionData.set(get(currentSessionId), [...currentLines]);

    currentSessionId.set(id);
    currentLines = [];
    parser.resetTurnState();

    // Show in-memory cache only if there's no localStorage cache that will
    // immediately replace it — avoids a double-render flash.
    const cached = sessionData.get(id);
    const hasLocalCache = !!localStorage.getItem('history_' + id);
    if (cached?.length > 0 && !hasLocalCache) {
      messages.set(parser.applyLines(cached));
      currentLines = [...cached];
    } else {
      messages.set([]);
    }

    await loadSessionHistory(id);
  }

  function sysMsg(text) {
    messages.update(ms => [...ms, { id: 'sys-' + ++sysCounter, role: 'system', text }]);
  }

  function handleSlash(text) {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/clear':
        messages.set([]); lastCost.set(null);
        parser.resetTurnState();
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'clear' }));
        return true;
      case '/status': {
        const h = get(hostStatus);
        const w = get(wsOk);
        sysMsg(`host: ${h}  ·  websocket: ${w ? 'connected' : 'disconnected'}`);
        return true;
      }
      case '/usage':
      case '/context': {
        const c = get(lastCost);
        const u = get(lastUsage);
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
            sessionId: get(currentSessionId),
            message: { role: 'user', content: arg },
          }));
        return true;
      default:
        return false;
    }
  }

  async function handleSend(text) {
    if (text.startsWith('/') && handleSlash(text)) return;

    if (get(currentSessionId) === '__new__') {
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
    ws.send(JSON.stringify({
      type: 'user',
      sessionId: get(currentSessionId),
      message: { role: 'user', content: text },
    }));
  }

  function handleSelect(id) {
    fileViewPath = null;
    diffViewCommit = null;
    switchSession(id);
    if (window.innerWidth <= 640) sidebarOpen = false;
  }

  function handleNewSession(cwd) {
    pendingCwd = cwd || null;
    fileViewPath = null;
    diffViewCommit = null;
    saveCurrentCache();
    history.pushState(null, '', '#new');
    currentSessionId.set('__new__');
    currentLines = [];
    messages.set([]);
    parser.resetTurnState();
    if (window.innerWidth <= 640) sidebarOpen = false;
  }

  async function handleDelete(id) {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) { console.error('handleDelete fetch:', e); }
  }

  function handleAgentCtl({ id, event }) {
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'agent_ctl', sessionId: id, event }));
    }
  }

  function handleFileOpen({ path }) {
    fileViewPath = path;
    diffViewCommit = null;
  }

  function handleDiffOpen({ commit }) {
    diffViewCommit = commit;
    fileViewPath = null;
  }
</script>

<div class="layout">
  <header>
    <button class="sidebar-toggle" onclick={() => sidebarOpen = !sidebarOpen}
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
    <button class="hc-toggle" onclick={() => highContrast.update(v => !v)}
      title="Toggle high contrast" aria-pressed={$highContrast}>HC</button>
    <button class="logout" onclick={onLogout}>logout</button>
  </header>

  <div class="body">
    {#if sidebarOpen}
      <div class="backdrop" onclick={() => sidebarOpen = false} aria-hidden="true"></div>
    {/if}
    <SessionSidebar
      sessions={$sessions}
      currentId={$currentSessionId}
      open={sidebarOpen}
      {hostCwd}
      sessionId={$currentSessionId}
      {token}
      onSelect={handleSelect}
      onDelete={handleDelete}
      onNewSession={handleNewSession}
      onAgentCtl={handleAgentCtl}
      onFileOpen={handleFileOpen}
      onDiffOpen={handleDiffOpen}
    />
    <div class="chat">
      {#if diffViewCommit}
        <DiffView
          sessionId={$currentSessionId}
          commit={diffViewCommit}
          {token}
          onClose={() => diffViewCommit = null}
        />
      {:else if fileViewPath}
        <FileView
          sessionId={$currentSessionId}
          path={fileViewPath}
          {token}
          onClose={() => fileViewPath = null}
        />
      {:else}
        <MessageList hostStatus={$hostStatus} />
        <ChatInput
          disabled={inputDisabled}
          placeholder={inputPlaceholder}
          sendLabel={currentAgentActive ? 'send' : 'send & start'}
          onSend={handleSend}
        />
      {/if}
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
