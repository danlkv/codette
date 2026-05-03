<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { onMount, onDestroy, tick, createEventDispatcher } from 'svelte';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import SessionSidebar from './SessionSidebar.svelte';
  export let token;
  const dispatch = createEventDispatcher();

  marked.use({ breaks: true });

  function renderMd(text) {
    return DOMPurify.sanitize(marked.parse(text || ''));
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function toolSummary(name, input) {
    if (!input) return '';
    switch (name) {
      case 'Bash': {
        const first = (input.command || '').split('\n')
          .find(l => l.trim() && !l.trim().startsWith('#'));
        return first?.trim().slice(0, 100) || '';
      }
      case 'WebSearch':
      case 'web_search':
        return input.query || '';
      case 'Read':        return input.file_path || input.path || '';
      case 'Write':       return input.file_path || input.path || '';
      case 'Edit':        return input.file_path || input.path || '';
      case 'Grep':        return input.pattern   || '';
      case 'LS':          return input.path       || '';
      default:            return '';
    }
  }

  let ws, wsOk = false, hostStatus = 'disconnected';
  let messages = [];       // { role, text, tools: {name, summary}[], system?: true }
  let streaming = null;    // partial in-flight assistant message
  let serverStreaming = false; // server-reported: Claude is mid-response, history pending
  let input = '', scrollEl;
  let lastCost = null;  // from result events
  let sessions = [];       // [{id, title, ts, active}] for sidebar
  let currentSessionId = null;

  onMount(connect);
  onDestroy(() => ws?.close());

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen  = () => { wsOk = true; };
    ws.onclose = () => { wsOk = false; setTimeout(connect, 3000); };
    ws.onerror = () => {};
    ws.onmessage = ({ data }) => handle(JSON.parse(data));
  }

  function handle(msg) {
    if (msg.type === 'status') {
      hostStatus = msg.host;
      if (msg.streaming) serverStreaming = true;
    } else if (msg.type === 'clear') {
      messages = []; streaming = null; lastCost = null; serverStreaming = false;
    } else if (msg.type === 'history') {
      messages = []; streaming = null; lastCost = null; serverStreaming = false;
      for (const line of (msg.lines || [])) ingestEvent(line);
      scrollBottom();
    } else if (msg.type === 'session_list') {
      sessions = msg.sessions || [];
      currentSessionId = sessions.find(s => s.active)?.id ?? currentSessionId;
    } else if (msg.type === 'claude_line') {
      serverStreaming = false;
      ingestEvent(msg.line);
    }
  }

  function sidebarResume(e) {
    const id = e.detail;
    if (!wsOk) return;
    ws.send(JSON.stringify({ type: 'resume', sessionId: id }));
    messages = []; streaming = null; lastCost = null; serverStreaming = true;
    // Optimistically move to top and mark active
    sessions = [
      { ...sessions.find(s => s.id === id), active: true },
      ...sessions.filter(s => s.id !== id).map(s => ({ ...s, active: false }))
    ].filter(Boolean);
    currentSessionId = id;
    scrollBottom();
  }

  function ingestEvent(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }

    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      currentSessionId = ev.session_id;
      return;
    }

    if (ev.type === 'user') {
      // plain user text (not tool_result arrays)
      const content = ev.message?.content;
      if (typeof content === 'string' && content.trim()) {
        messages = [...messages, { role: 'user', text: content, tools: [], ts: ev.timestamp }];
      }
      return;
    }

    if (ev.type === 'assistant') {
      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      let text = '';
      const tools = [];
      for (const b of content) {
        if (b.type === 'text')     text += b.text;
        if (b.type === 'tool_use') tools.push({ name: b.name, summary: toolSummary(b.name, b.input) });
      }
      if (ev.message?.stop_reason) {
        messages = [...messages, { role: 'assistant', text, tools, ts: ev.timestamp }];
        streaming = null;
      } else {
        streaming = { text, tools };
      }
      scrollBottom();
    } else if (ev.type === 'result') {
      if (streaming) { messages = [...messages, { role: 'assistant', ...streaming }]; streaming = null; }
      if (ev.total_cost_usd != null) lastCost = ev.total_cost_usd;
      scrollBottom();
    }
  }

  // ── Slash commands ────────────────────────────────────────────────────────
  function sysMsg(text) {
    messages = [...messages, { role: 'system', text, tools: [] }];
    scrollBottom();
  }

  function handleSlash(raw) {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/clear':
        messages = []; streaming = null; lastCost = null;
        return true;
      case '/status':
        sysMsg(`host: ${hostStatus}  ws: ${wsOk ? 'connected' : 'disconnected'}`);
        return true;
      case '/usage':
        sysMsg(lastCost != null ? `session cost: $${lastCost.toFixed(4)}` : 'no cost data yet');
        return true;
      case '/btw':
        // send but don't add to local history
        if (wsOk && arg) ws.send(JSON.stringify({ type: 'user', message: { role: 'user', content: `/btw ${arg}` } }));
        return true;
      case '/resume':
        if (!arg) { sysMsg('usage: /resume <session-id>'); return true; }
        if (wsOk) ws.send(JSON.stringify({ type: 'resume', sessionId: arg }));
        messages = []; streaming = null; lastCost = null; serverStreaming = true;
        scrollBottom();
        return true;
      case '/compact':
      case '/model':
        // forward as a claude slash command
        if (wsOk) ws.send(JSON.stringify({ type: 'user', message: { role: 'user', content: raw } }));
        messages = [...messages, { role: 'user', text: raw, tools: [] }];
        scrollBottom();
        return true;
      default:
        return false;
    }
  }

  async function scrollBottom() {
    await tick();
    scrollEl?.scrollTo(0, scrollEl.scrollHeight);
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    input = '';
    if (text.startsWith('/') && handleSlash(text)) return;
    if (!wsOk) return;
    messages = [...messages, { role: 'user', text, tools: [] }];
    ws.send(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }));
    scrollBottom();
  }

  function keydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  $: canSend = wsOk && input.trim();
  $: placeholder = !wsOk ? 'Connecting…' : hostStatus !== 'connected' ? 'Waiting for host…' : 'Message (Enter ↵)';
</script>

<div class="layout">
<SessionSidebar {sessions} currentId={currentSessionId} on:resume={sidebarResume} />
<div class="chat">
  <header>
    <span class="title">Claude</span>
    <span class="pills">
      <span class="pill" class:on={hostStatus === 'connected'} title="host {hostStatus}">host</span>
      <span class="pill" class:on={wsOk} title="ws {wsOk ? 'ok' : 'off'}">ws</span>
    </span>
    <button class="logout" on:click={() => dispatch('logout')} title="Logout">×</button>
  </header>

  <div class="msgs" bind:this={scrollEl}>
    {#each messages as m, i (i)}
      {#if m.role === 'system'}
        <p class="sys-msg">{m.text}</p>
      {:else}
        <div class="msg {m.role}">
          <span class="label">{m.role === 'user' ? 'you' : 'claude'}{#if m.ts}<span class="msg-time">{fmtTime(m.ts)}</span>{/if}</span>
          <div class="body">
            {#if m.role === 'user'}
              <p class="user-text">{m.text}</p>
            {:else}
              <div class="md">{@html renderMd(m.text)}</div>
            {/if}
            {#each m.tools as t}
              <div class="tool">
                <span class="tool-icon">⚙</span>
                <span class="tool-name">{t.name}</span>
                {#if t.summary}<span class="tool-arg">{t.summary}</span>{/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/each}

    {#if streaming}
      <div class="msg assistant">
        <span class="label">claude</span>
        <div class="body">
          <div class="md streaming">{@html renderMd(streaming.text)}<span class="cur">▌</span></div>
          {#each streaming.tools as t}
            <div class="tool">
              <span class="tool-icon">⚙</span>
              <span class="tool-name">{t.name}</span>
              {#if t.summary}<span class="tool-arg">{t.summary}</span>{/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if serverStreaming && !streaming}
      <div class="msg assistant">
        <span class="label">claude</span>
        <div class="body"><span class="waiting">responding<span class="cur">▌</span></span></div>
      </div>
    {/if}

    {#if messages.length === 0 && !streaming && !serverStreaming}
      <p class="empty">
        {#if hostStatus !== 'connected'}Start the host: <code>node host/index.js</code>{:else}Say something…{/if}
      </p>
    {/if}
  </div>

  <div class="bar">
    <textarea bind:value={input} on:keydown={keydown} {placeholder} rows="3"></textarea>
    <button on:click={send} disabled={!canSend}>↵</button>
  </div>
</div>
</div>

<style>
  .layout { display: flex; height: 100dvh; overflow: hidden; }
  .chat { display: flex; flex-direction: column; flex: 1; min-width: 0; }

  header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 14px; background: var(--bg-secondary); border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .title { font-weight: 600; color: var(--text); flex: 1; }
  .pills { display: flex; gap: 5px; }
  .pill {
    font-size: .75rem; padding: 2px 6px; border-radius: 3px;
    background: var(--bg-elevated); color: var(--text-muted); border: 1px solid var(--border);
  }
  .pill.on { color: var(--status-ok); border-color: var(--status-ok); }
  .logout { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 1.2rem; padding: 2px 4px; }
  .logout:hover { color: var(--text); }

  .msgs {
    flex: 1; overflow-y: auto; padding: 16px 14px;
    display: flex; flex-direction: column; gap: 16px;
  }

  .msg { display: flex; gap: 10px; }
  .label {
    font-size: .75rem; color: var(--text-muted); width: 44px; flex-shrink: 0;
    padding-top: 3px; text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
  }
  .msg.user .label { color: var(--user-label); }
  .msg-time { font-size: .6rem; color: var(--text-dim); font-weight: 400; }
  .body { flex: 1; min-width: 0; }

  /* user messages: plain text */
  .user-text { color: var(--user-text); line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin: 0; }

  /* markdown container */
  .md { color: var(--text); line-height: 1.65; }

  /* markdown elements — use :global because {@html} bypasses scoped CSS */
  .md :global(p)              { margin: 0 0 0.65em; }
  .md :global(p:last-child)   { margin-bottom: 0; }
  .md :global(h1), .md :global(h2), .md :global(h3),
  .md :global(h4), .md :global(h5), .md :global(h6) {
    font-weight: 600; color: var(--text); margin: 1em 0 0.3em; line-height: 1.3;
  }
  .md :global(h1) { font-size: 1.15em; }
  .md :global(h2) { font-size: 1.05em; }
  .md :global(h3), .md :global(h4) { font-size: 1em; }
  .md :global(code) {
    background: var(--code-bg); border: 1px solid var(--border); border-radius: 3px;
    padding: 1px 5px; font-size: .88em; color: var(--code-color);
  }
  .md :global(pre) {
    background: var(--pre-bg); border: 1px solid var(--border); border-radius: 5px;
    padding: 10px 14px; overflow-x: auto; margin: 0.6em 0;
  }
  .md :global(pre code) {
    background: none; border: none; padding: 0; color: var(--pre-code); font-size: .88em;
  }
  .md :global(ul), .md :global(ol) { padding-left: 1.5em; margin: 0.4em 0; }
  .md :global(li)             { margin: 0.25em 0; }
  .md :global(blockquote) {
    border-left: 3px solid var(--text-dim); margin: 0.5em 0;
    padding: 0.1em 0 0.1em 0.9em; color: var(--text-muted);
  }
  .md :global(a)              { color: var(--link); text-decoration: none; }
  .md :global(a:hover)        { text-decoration: underline; }
  .md :global(strong)         { color: var(--text); font-weight: 600; }
  .md :global(em)             { color: var(--text-muted); }
  .md :global(hr)             { border: none; border-top: 1px solid var(--border); margin: 0.8em 0; }
  .md :global(table)          { border-collapse: collapse; width: 100%; margin: 0.5em 0; font-size: .88em; }
  .md :global(th), .md :global(td) { border: 1px solid var(--border); padding: 4px 10px; }
  .md :global(th)             { background: var(--code-bg); color: var(--text); }

  /* streaming cursor sits after the last rendered element */
  .md.streaming :global(p:last-child)::after { content: none; }

  /* tool call row */
  .tool {
    display: flex; align-items: baseline; gap: 5px;
    font-size: .78rem; margin-top: 6px;
    color: var(--text-dim);
  }
  .tool-icon { color: var(--text-muted); }
  .tool-name { color: var(--tool-name); font-weight: 500; }
  .tool-arg  {
    color: var(--text-dim); font-size: .95em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60ch;
  }

  .waiting { color: var(--text-muted); font-style: italic; font-size: .9rem; }
  .cur { color: var(--cursor); animation: blink .7s step-end infinite; display: inline; }
  @keyframes blink { 50% { opacity: 0; } }

  .sys-msg { color: var(--text-muted); font-size: .8rem; text-align: center; font-style: italic; margin: 0; }
  .empty { color: var(--text-dim); text-align: center; margin-top: 40px; line-height: 1.7; }
  .empty code { color: var(--text-muted); background: var(--bg-elevated); padding: 1px 5px; border-radius: 3px; }

  .bar {
    display: flex; gap: 8px; padding: 10px 14px;
    background: var(--bg-secondary); border-top: 1px solid var(--border); flex-shrink: 0;
  }
  textarea {
    flex: 1; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text);
    padding: 8px 10px; border-radius: 4px; font: inherit; resize: none; line-height: 1.5;
  }
  textarea:focus { outline: none; border-color: var(--text-muted); }
  .bar button {
    background: var(--btn-bg); color: var(--text); border: none;
    padding: 8px 14px; border-radius: 4px; cursor: pointer; font-size: 1.1rem; align-self: flex-end;
  }
  .bar button:hover:not(:disabled) { background: var(--btn-hover); }
  .bar button:disabled { opacity: .3; cursor: default; }
</style>
