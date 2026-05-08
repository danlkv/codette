<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';

  import { makeInlineFilePrompt } from '../../../shared/prompts.js';
  import { messages, lastCost, lastUsage, lastContextUsage, hostStatus, wsOk, highContrast, vibrateOnDone, fontStyle, syntaxTheme, accentColor,
           sessions, currentSessionId, sessionData } from '../store.js';
  import { createParser } from './parser.js';
  import { summarizeOldLines, KEEP as SUMMARIZE_KEEP } from './summarize.js';
  import MessageList from './MessageList.svelte';
  import ChatInput from './ChatInput.svelte';
  import SessionSidebar from './SessionSidebar.svelte';
  import FileView from './FileView.svelte';
  import DiffView from './DiffView.svelte';

  let { token, accounts = [], activeIdx = 0, onLogout, onSwitch, onAddAccount } = $props();

  const username = $derived.by(() => {
    try { return JSON.parse(atob(token.split('.')[1])).username; } catch { return ''; }
  });
  let userMenuOpen = $state(false);
  $effect(() => { localStorage.setItem('vibrate', $vibrateOnDone ? '1' : '0'); });
  $effect(() => {
    if (!userMenuOpen) return;
    function onDocClick(e) {
      if (!e.target.closest('.user-menu-wrap')) userMenuOpen = false;
    }
    document.addEventListener('click', onDocClick, true);
    return () => document.removeEventListener('click', onDocClick, true);
  });

  let storedContextWindow = null;
  const parser = createParser({ messages, currentSessionId, lastCost, lastUsage, lastContextUsage,
    onContextWindow(cw) { storedContextWindow = cw; } });

  let ws;
  let destroyed = false;
  let sysCounter = 0;

  let sidebarOpen = $state(true);
  let hostCwd = $state(null);
  let fileViewPath = $state(null);
  let diffViewCommit = $state(null);
  let historyLoading = $state(true);
  let currentLines = [];       // raw jsonl lines for current session (for cache writes)
  let sessionTitle = $state('');
  let awaitingNewSession = false;
  let pendingCwd = null;
  let pendingSettings = null;

  let currentAgentState = $derived($sessions.find(s => s.id === $currentSessionId)?.agentState ?? null);
  let currentAgentActive = $derived(!!currentAgentState);
  let sendPending = $state(false);
  let pendingClearFn = null;
  let pendingEchoTimer = null;
  let ctxBarOpen = $state(false);
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

  // Hash helpers: format is #username/sessionId (legacy: #sessionId)
  function parseHash() {
    const h = location.hash.slice(1);
    if (!h) return { sessionId: null, file: null };
    const [base, query] = h.split('?');
    const slash = base.indexOf('/');
    const sessionId = (slash >= 0 ? base.slice(slash + 1) : base) || null;
    const file = query ? (new URLSearchParams(query).get('file') || null) : null;
    return { sessionId, file };
  }
  function parseHashSessionId() { return parseHash().sessionId; }
  function makeHash(sessionId, filePath = null) {
    const base = '#' + (username ? username + '/' : '') + sessionId;
    return filePath ? base + '?file=' + encodeURIComponent(filePath) : base;
  }

  function onPopState() {
    const { sessionId: id, file } = parseHash();
    if (!id || id === get(currentSessionId)) {
      fileViewPath = file;
      return;
    }
    if (id === 'new') { handleNewSession(null); return; }
    switchSession(id);
    fileViewPath = file;
  }

  onMount(async () => {
    sidebarOpen = window.innerWidth > 640;
    window.addEventListener('beforeunload', saveCurrentCache);
    window.addEventListener('popstate', onPopState);
    console.log('[history] onMount: calling initSessions');
    await initSessions();
    console.log('[history] onMount: initSessions done, historyLoading=false, calling connect');
    historyLoading = false;
    connect();
  });
  onDestroy(() => {
    destroyed = true;
    saveCurrentCache();
    window.removeEventListener('beforeunload', saveCurrentCache);
    window.removeEventListener('popstate', onPopState);
    ws?.close();
  });

  const dedupById = arr => [...new Map(arr.map(s => [s.id, s])).values()];

  async function initSessions() {
    let sessionList = [];
    console.log('[history] initSessions: fetching sessions');
    try {
      const res = await fetch('/api/sessions', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        sessionList = data.sessions ?? data;
        if (data.hostCwd) hostCwd = data.hostCwd;
        sessions.set(dedupById(sessionList));
        console.log('[history] initSessions: got', sessionList.length, 'sessions');
      } else {
        console.warn('[history] initSessions: fetch failed', res.status);
      }
    } catch (e) { console.error('[history] initSessions: fetch error', e); }

    if (sessionList.length === 0) { console.log('[history] initSessions: no sessions, returning'); return; }
    const { sessionId: hashId, file: hashFile } = parseHash();
    const target = (hashId && hashId !== 'new' && sessionList.find(s => s.id === hashId))
      ? hashId
      : sessionList[0].id;
    console.log('[history] initSessions: target session', target, '(hash was:', hashId + ')');
    history.replaceState(null, '', makeHash(target, hashFile));
    currentSessionId.set(target);
    if (hashFile) fileViewPath = hashFile;
    await loadSessionHistory(target);
  }

  // Evict the N oldest history_* entries (by ts field), skipping currentKey.
  function evictOldestSessions(currentKey, n = 2) {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith('history_') || k === currentKey) continue;
      try {
        const ts = JSON.parse(localStorage.getItem(k))?.ts ?? 0;
        entries.push({ k, ts });
      } catch { entries.push({ k, ts: 0 }); }
    }
    entries.sort((a, b) => a.ts - b.ts);
    const toEvict = entries.slice(0, n);
    for (const { k } of toEvict) {
      localStorage.removeItem(k);
      console.log('[history] evicted', k);
    }
    return toEvict.length;
  }

  // Try to store history; on QuotaExceededError:
  //   1. summarize old lines and retry
  //   2. evict 2 oldest sessions and retry
  // lineCount is always the real count so server offsets stay correct.
  function tryStoreHistory(cacheKey, lines, lineCount, title = '', contextWindow = null) {
    const byteEst = s => new Blob([s]).size;
    const ts = Date.now();
    const raw = JSON.stringify({ lines, lineCount, ts, title, ...(contextWindow && { contextWindow }) });
    console.log('[history] tryStoreHistory:', cacheKey, lines.length, 'lines, lineCount=', lineCount, '~', (byteEst(raw)/1024).toFixed(1), 'KB');
    try { localStorage.setItem(cacheKey, raw); console.log('[history] tryStoreHistory: saved ok'); return; }
    catch (e) { if (e.name !== 'QuotaExceededError') { console.error('[history] tryStoreHistory:', e); return; } }

    const summarized = lines.length > SUMMARIZE_KEEP
      ? [...summarizeOldLines(lines.slice(0, -SUMMARIZE_KEEP)), ...lines.slice(-SUMMARIZE_KEEP)]
      : summarizeOldLines(lines);
    const sumRaw = JSON.stringify({ lines: summarized, lineCount, ts });
    console.log('[history] tryStoreHistory: quota exceeded, summarized', lines.length, '→', summarized.length, 'lines,', (byteEst(sumRaw)/1024).toFixed(1), 'KB');

    try { localStorage.setItem(cacheKey, sumRaw); console.log('[history] tryStoreHistory: saved ok (summarized)'); return; }
    catch (e) { if (e.name !== 'QuotaExceededError') { console.error('[history] tryStoreHistory after summarize:', e); return; } }

    const evicted = evictOldestSessions(cacheKey, 2);
    if (evicted === 0) { console.warn('[history] tryStoreHistory: nothing to evict, giving up'); return; }
    try { localStorage.setItem(cacheKey, sumRaw); console.log('[history] tryStoreHistory: saved ok (after eviction)'); return; }
    catch (e) { console.warn('[history] tryStoreHistory: quota exceeded even after eviction, skipping cache for', cacheKey); }
  }

  function saveCurrentCache() {
    const id = get(currentSessionId);
    if (!id || currentLines.length === 0) return;
    console.log('[history] saveCurrentCache:', id, currentLines.length, 'lines');
    tryStoreHistory('history_' + id, currentLines, currentLines.length, sessionTitle, storedContextWindow);
  }

  async function loadSessionHistory(id) {
    if (!id || id === '__new__') return;
    const cacheKey = 'history_' + id;
    let cached = null;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        cached = JSON.parse(raw);
        if (!('lineCount' in cached)) { console.warn('[history] loadSessionHistory: invalid cache (no lineCount), ignoring'); cached = null; }
      }
    } catch (e) { console.error('[history] loadSessionHistory: localStorage read error', e); }

    console.log('[history] loadSessionHistory', id, '— localStorage cache:', cached ? cached.lines.length + ' lines (lineCount=' + cached.lineCount + ')' : 'none');
    if (cached) {
      if (cached.title) sessionTitle = cached.title;
      if (cached.contextWindow) storedContextWindow = cached.contextWindow;
      applyHistoryLines(cached.lines);
      console.log('[history] loadSessionHistory: applied localStorage cache, messages.length=', cached.lines.length);
    }
    await fetchAndApplyHistory(id, cached, cacheKey);
  }

  async function fetchAndApplyHistory(id, cached, cacheKey) {
    try {
      const offset = cached ? cached.lineCount : null;
      const params = offset ? `?offset=${offset}` : '';
      console.log('[history] fetchAndApplyHistory', id, '— offset:', offset ?? 'none (full fetch)');
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/history${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { console.warn('[history] fetchAndApplyHistory: server returned', res.status); return; }
      const data = await res.json();
      const lines = data.lines ?? [];
      console.log('[history] fetchAndApplyHistory: got', lines.length, 'lines, incremental=', data.incremental, 'totalLines=', data.totalLines);

      if (data.incremental && cached) {
        if (lines.length === 0) {
          if (data.totalLines !== undefined && cached.lineCount > data.totalLines) {
            console.warn('[history] fetchAndApplyHistory: cache lineCount', cached.lineCount, '> server totalLines', data.totalLines, '— re-fetching full');
            await fetchAndApplyHistory(id, null, cacheKey);
          } else {
            console.log('[history] fetchAndApplyHistory: no new lines, cache is up to date');
          }
          return;
        }
        const merged = [...cached.lines, ...lines];
        console.log('[history] fetchAndApplyHistory: merged', cached.lines.length, '+', lines.length, '=', merged.length, 'lines');
        applyHistoryLines(merged);
        tryStoreHistory(cacheKey, merged, merged.length, sessionTitle, storedContextWindow);
      } else {
        console.log('[history] fetchAndApplyHistory: applying', lines.length, 'lines (full)');
        applyHistoryLines(lines);
        tryStoreHistory(cacheKey, lines, lines.length, sessionTitle, storedContextWindow);
      }
    } catch (e) { console.error('fetchAndApplyHistory:', e); }
  }

  function applyHistoryLines(lines) {
    const filtered = [];
    for (const line of lines) {
      try { const ev = JSON.parse(line); if (ev.type === 'ai-title') { if (ev.aiTitle) sessionTitle = ev.aiTitle; continue; } } catch {}
      filtered.push(line);
    }
    currentLines = filtered;
    messages.set(parser.applyLines(filtered));
    if (storedContextWindow) lastContextUsage.update(v => v ? { ...v, total: storedContextWindow } : v);
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen  = () => { if (!destroyed) wsOk.set(true); };
    ws.onclose = () => { wsOk.set(false); if (!destroyed) setTimeout(connect, 3000); };
    ws.onerror = () => {};
    ws.onmessage = ({ data }) => {
      if (destroyed) return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'session_list') {
        sessions.set(dedupById(msg.sessions ?? []));
        if (msg.hostCwd) hostCwd = msg.hostCwd;
      }
      else if (msg.type === 'claude_line') {
        const { sessionId, line } = msg;
        if (sessionId === get(currentSessionId)) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'ai-title') { if (ev.aiTitle) sessionTitle = ev.aiTitle; return; }
            if (ev.type === 'user' && typeof ev.message?.content === 'string') {
              clearTimeout(pendingEchoTimer);
              sendPending = false;
              pendingClearFn?.();
              pendingClearFn = null;
            }
          } catch {}
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
          if (event === 'idle' && sessionId === get(currentSessionId) && get(vibrateOnDone)) {
            navigator.vibrate?.(40);
          }
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
    history.pushState(null, '', makeHash(id));

    fileViewPath = null;
    diffViewCommit = null;
    saveCurrentCache();

    if (get(currentSessionId)) { console.log('[history] switchSession: saving', currentLines.length, 'lines to sessionData for', get(currentSessionId)); sessionData.set(get(currentSessionId), [...currentLines]); }

    currentSessionId.set(id);
    currentLines = [];
    sessionTitle = '';
    storedContextWindow = null;
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

  async function handleSlash(text) {
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
      case '/reload': {
        const id = get(currentSessionId);
        if (id && id !== '__new__') {
          localStorage.removeItem('history_' + id);
          currentLines = [];
          messages.set([]);
          parser.resetTurnState();
          sysMsg('cache cleared — refetching…');
          await loadSessionHistory(id);
        }
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
      case '/claudeweb-inline-files': {
        const sid = get(currentSessionId);
        const cwd = get(sessions).find(s => s.id === sid)?.cwd ?? null;
        const prompt = makeInlineFilePrompt(cwd);
        if (ws?.readyState === 1)
          ws.send(JSON.stringify({
            type: 'user',
            sessionId: sid,
            message: { role: 'user', content: prompt },
          }));
        sysMsg('inline file viewer enabled');
        return true;
      }
      default:
        return false;
    }
  }

  async function handleSend(text, clearFn) {
    if (text.startsWith('/') && handleSlash(text)) { clearFn?.(); return; }

    if (get(currentSessionId) === '__new__') {
      awaitingNewSession = true;
      try {
        await fetch('/api/sessions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: pendingCwd, firstMessage: text, claudeweb_settings: pendingSettings ?? undefined }),
        });
        clearFn?.();
      } catch { awaitingNewSession = false; }
      return;
    }

    if (ws?.readyState !== 1) return;
    sendPending = true;
    pendingClearFn = clearFn ?? null;
    clearTimeout(pendingEchoTimer);
    pendingEchoTimer = setTimeout(() => {
      sendPending = false;
      pendingClearFn = null;
    }, 8000);
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

  function handleNewSession(cwd, settings = null) {
    pendingCwd = cwd || null;
    pendingSettings = settings;
    fileViewPath = null;
    diffViewCommit = null;
    saveCurrentCache();
    history.pushState(null, '', makeHash('new'));
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
    history.pushState(null, '', makeHash(get(currentSessionId), path));
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
    <span class="session-title">{sessionTitle}</span>
    <div class="indicators">
      <span class="dot" class:on={$hostStatus === 'connected'}>host</span>
      <span class="dot" class:on={$wsOk}>ws</span>
      <span class="dot ai" class:on={currentAgentActive} class:idle={currentAgentState === 'idle'}>ai</span>
      {#if $lastCost != null}
        <span class="cost">${$lastCost.toFixed(4)}</span>
      {/if}
    </div>
    <div class="user-menu-wrap">
      <button class="user-btn" onclick={() => userMenuOpen = !userMenuOpen}>{username} <span class="gear">⚙</span></button>
      {#if userMenuOpen}
        <div class="user-menu">
          <div class="menu-section-label">accounts</div>
          <button class="account-active" disabled>{username}</button>
          {#each accounts as acc, i}
            {#if i !== activeIdx}
              <button onclick={() => { userMenuOpen = false; onSwitch?.(i); }}>{acc.username}</button>
            {/if}
          {/each}
          <button onclick={() => { userMenuOpen = false; onAddAccount?.(); }}>+ add account</button>
          <button class="logout-btn" onclick={() => { userMenuOpen = false; onLogout(); }}>logout</button>
          <div class="menu-sep"></div>
          <div class="menu-section-label">settings</div>
          <label class="menu-toggle">
            <span>high contrast</span>
            <input type="checkbox" checked={$highContrast}
              onchange={() => highContrast.update(v => !v)} />
          </label>
          <label class="menu-toggle">
            <span>vibrate on done</span>
            <input type="checkbox" checked={$vibrateOnDone}
              onchange={() => vibrateOnDone.update(v => !v)} />
          </label>
          <div class="menu-toggle">
            <span>font</span>
            <div class="font-pick">
              {#each ['mono', 'sans', 'serif'] as f}
                <button class="font-btn" class:active={$fontStyle === f}
                  onclick={() => fontStyle.set(f)}>{f}</button>
              {/each}
            </div>
          </div>
          <div class="menu-toggle">
            <span>accent</span>
            <div class="accent-pick">
              <input type="color" value={$accentColor ?? '#cc5500'}
                oninput={e => accentColor.set(e.currentTarget.value)} />
              {#if $accentColor}
                <button class="accent-reset" onclick={() => accentColor.set(null)}>reset</button>
              {/if}
            </div>
          </div>
          <div class="menu-toggle">
            <span>syntax</span>
            <select class="theme-select" value={$syntaxTheme ?? ''}
              onchange={e => syntaxTheme.set(e.currentTarget.value || null)}>
              <option value="">none</option>
              <optgroup label="dark">
                <option value="github-dark">github dark</option>
                <option value="one-dark-pro">one dark pro</option>
                <option value="catppuccin-mocha">catppuccin mocha</option>
                <option value="nord">nord</option>
                <option value="dracula">dracula</option>
                <option value="tokyo-night">tokyo night</option>
                <option value="rose-pine">rose pine</option>
                <option value="solarized-dark">solarized dark</option>
                <option value="vitesse-dark">vitesse dark</option>
              </optgroup>
              <optgroup label="light">
                <option value="github-light">github light</option>
                <option value="rose-pine-dawn">rose pine dawn</option>
                <option value="solarized-light">solarized light</option>
                <option value="vitesse-light">vitesse light</option>
              </optgroup>
              <optgroup label="high contrast">
                <option value="github-dark-high-contrast">github dark hc</option>
                <option value="github-light-high-contrast">github light hc</option>
              </optgroup>
            </select>
          </div>
        </div>
      {/if}
    </div>
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
          onClose={() => { fileViewPath = null; history.pushState(null, '', makeHash(get(currentSessionId))); }}
        />
      {/if}
      <div class="chat-main" class:hidden={fileViewPath || diffViewCommit}>
        <MessageList hostStatus={$hostStatus} {historyLoading} sessionId={$currentSessionId} {token} onOpenFile={path => handleFileOpen({ path })} />
        <div class="ctx-shell" class:ctx-open={ctxBarOpen}
          style={$lastContextUsage ? `--ctx-pct:${Math.min(100, $lastContextUsage.used / $lastContextUsage.total * 100).toFixed(1)}%` : '--ctx-pct:0%'}>
          <div class="ctx-above">
            <div class="ctx-above-inner">
              {#if $lastContextUsage}
                ctx <em>{Math.round($lastContextUsage.used / 1000)}k / {Math.round($lastContextUsage.total / 1000)}k</em>
                {#if $lastContextUsage.out}
                  <span class="ctx-sep">·</span> last out: <em>{($lastContextUsage.out / 1000).toFixed(1)}k</em>
                {/if}
                {#if $lastContextUsage.cacheRead && $lastContextUsage.used}
                  <span class="ctx-sep">·</span> input cache: <em>{Math.round($lastContextUsage.cacheRead / $lastContextUsage.used * 100)}%</em>
                {/if}
              {:else}
                <span class="ctx-dim">no data yet — complete a turn first</span>
              {/if}
            </div>
          </div>
          <ChatInput
            disabled={inputDisabled || sendPending}
            placeholder={inputPlaceholder}
            sendLabel={sendPending ? '…' : currentAgentActive ? 'send' : 'send & start'}
            onSend={handleSend}
          />
          <button class="ctx-strip" onclick={() => ctxBarOpen = !ctxBarOpen} title="Token usage"></button>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .layout { display: flex; flex-direction: column; height: var(--app-height, 100dvh); }
  .body { display: flex; flex: 1; overflow: hidden; position: relative; }
  .chat { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  .chat-main { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  .chat-main.hidden { display: none; }

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
  .brand { color: var(--accent); font-weight: 600; font-size: .88rem; }
  .session-title {
    flex: 1; text-align: center;
    font-size: .78rem; color: var(--text-dim);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    min-width: 0;
  }
  .indicators { display: flex; align-items: center; gap: 8px; }
  .dot { font-size: .72rem; color: var(--text-dim); }
  .dot.on { color: #5a5; }
  .dot.ai.on { color: var(--accent-light); }
  .dot.ai.idle { color: #5a5; }
  .cost { font-size: .72rem; color: var(--text-dim); }
  .user-menu-wrap { position: relative; }
  .user-btn {
    background: none; border: none; color: var(--text-dim);
    cursor: pointer; font: inherit; font-size: .72rem; padding: 0;
    display: flex; align-items: center; gap: 5px;
  }
  .user-btn:hover { color: var(--text-muted); }
  .gear { color: var(--text); font-size: 1rem; line-height: 1; }
  .user-menu {
    position: absolute; right: 0; top: calc(100% + 6px);
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px; min-width: 200px;
    box-shadow: 0 6px 20px rgba(0,0,0,.4); z-index: 100;
  }
  .menu-section-label {
    font-size: .65rem; color: var(--text-dim); text-transform: uppercase;
    letter-spacing: .06em; padding: 4px 8px 2px; user-select: none;
  }
  .user-menu button {
    display: block; width: 100%; text-align: left;
    background: none; border: none; color: var(--text-muted);
    cursor: pointer; font: inherit; font-size: .82rem;
    padding: 6px 10px; border-radius: 4px;
  }
  .user-menu button:hover:not(:disabled) { background: var(--bg-secondary); color: var(--text); }
  .user-menu .account-active { color: var(--text); font-weight: 600; cursor: default; }
  .user-menu .logout-btn { color: var(--text-dim); }
  .menu-sep { height: 1px; background: var(--border); margin: 5px 4px; }
  .menu-toggle {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px; border-radius: 4px; cursor: pointer;
    font-size: .82rem; color: var(--text-muted);
  }
  .menu-toggle:hover { background: var(--bg-secondary); color: var(--text); }
  .menu-toggle input[type="checkbox"] { accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer; }
  .font-pick {
    display: flex; border: 1px solid var(--border); border-radius: 3px; overflow: hidden;
    margin-left: 12px;
  }
  .font-btn {
    background: none; border: none; border-right: 1px solid var(--border);
    color: var(--text-muted); font: inherit; font-size: .68rem;
    padding: 2px 7px; cursor: pointer; transition: background .1s, color .1s;
    min-width: 34px; text-align: center;
  }
  .font-btn:last-child { border-right: none; }
  .font-btn:hover { background: var(--bg-secondary); color: var(--text); }
  .font-btn.active { background: var(--accent); color: #fff; }
  .accent-pick { display: flex; align-items: center; gap: 6px; margin-left: 12px; }
  .accent-pick input[type="color"] {
    width: 28px; height: 20px; padding: 0; border: 1px solid var(--border);
    border-radius: 3px; background: none; cursor: pointer;
  }
  .accent-reset {
    background: none; border: none; color: var(--text-dim); font: inherit;
    font-size: .68rem; cursor: pointer; padding: 0;
  }
  .accent-reset:hover { color: var(--text-muted); }
  .theme-select {
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 3px; color: var(--text-muted); font: inherit;
    font-size: .72rem; padding: 2px 4px; cursor: pointer;
    margin-left: 12px;
  }
  .theme-select:hover { border-color: var(--accent); color: var(--text); }

  .ctx-shell { position: relative; }
  .ctx-shell :global(.wrap) { padding-left: 22px; }

  .ctx-above { overflow: hidden; max-height: 0; transition: max-height .18s ease; }
  .ctx-shell.ctx-open .ctx-above { max-height: 30px; }
  .ctx-above-inner {
    display: flex; align-items: baseline; gap: 5px; flex-wrap: nowrap;
    padding: 3px 16px 3px 22px; border-bottom: 1px solid var(--border);
    font: .62rem/1 monospace; color: var(--text-dim); justify-content: flex-end;
  }
  .ctx-above-inner em { color: var(--accent-light); font-style: normal; }
  .ctx-sep { color: var(--border); margin: 0 2px; }
  .ctx-dim { font-style: italic; }

  .ctx-strip {
    position: absolute; left: 0; top: 0; bottom: 0; width: 16px;
    background: none; border: none; cursor: pointer; padding: 0;
    display: flex; align-items: stretch;
  }
  .ctx-strip::before {
    content: ''; width: 6px;
    background: linear-gradient(to top, var(--accent) var(--ctx-pct, 0%), var(--bg-elevated) var(--ctx-pct, 0%));
    opacity: .55; transition: opacity .15s;
  }
  .ctx-strip:hover::before { opacity: 1; }
  .ctx-shell.ctx-open .ctx-strip::before { opacity: 1; }
</style>
