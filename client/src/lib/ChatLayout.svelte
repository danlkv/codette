<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { messages, lastCost, hostStatus, wsOk, highContrast } from '../store.js';
  import { toolSummary } from '../utils/tools.js';
  import MessageList from './MessageList.svelte';
  import ChatInput from './ChatInput.svelte';
  export let token;
  const dispatch = createEventDispatcher();

  let ws;
  let msgCounter = 0;
  const uid = () => ++msgCounter;

  // per-turn tracking
  let seenToolIds = new Set();
  let liveClaudeId = null;  // ev.message.id of the assistant message being streamed
  let liveUid = null;       // our messages[] id for that row

  onMount(connect);
  onDestroy(() => ws?.close());

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen  = () => wsOk.set(true);
    ws.onclose = () => { wsOk.set(false); setTimeout(connect, 3000); };
    ws.onerror = () => {};
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === 'status') {
        hostStatus.set(msg.host);
        if (msg.host === 'disconnected') finalizeIncomplete();
      }
      else if (msg.type === 'clear')       { messages.set([]); lastCost.set(null); resetTurnState(); }
      else if (msg.type === 'claude_line') parseLine(msg.line);
      else if (msg.type === 'history')     loadHistory(msg.lines);
    };
  }

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

  function loadHistory(lines) {
    messages.set([]);
    resetTurnState();
    for (const line of lines) parseLine(line);
    finalizeIncomplete(); // in case history ends mid-turn
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

  function parseLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }

    if (ev.type === 'user_message') {
      messages.update(ms => [...ms, { id: uid(), role: 'user', text: ev.text }]);
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

      // extract accumulated text for this message
      let text = '';
      for (const b of content) {
        if (b.type === 'text') text += b.text;
      }

      if (text) {
        if (claudeId && claudeId === liveClaudeId && liveUid !== null) {
          // same Claude message — update text in place
          messages.update(ms => ms.map(m =>
            m.id === liveUid ? { ...m, text } : m
          ));
        } else {
          // new Claude message — finalize previous if any, open new row
          if (liveUid !== null) {
            messages.update(ms => ms.map(m =>
              m.id === liveUid ? { ...m, streaming: false } : m
            ));
          }
          liveClaudeId = claudeId;
          liveUid = uid();
          messages.update(ms => [...ms, { id: liveUid, role: 'assistant', text, streaming: true }]);
        }
      }

      // commit each new tool_use as its own row immediately
      for (const b of content) {
        if (b.type === 'tool_use' && !seenToolIds.has(b.id)) {
          seenToolIds.add(b.id);
          commitTool(b);
        }
      }

    } else if (ev.type === 'result') {
      // finalize live assistant message
      if (liveUid !== null) {
        messages.update(ms => ms.map(m =>
          m.id === liveUid ? { ...m, streaming: false } : m
        ));
        liveUid = null;
        liveClaudeId = null;
      }
      // mark all running tools done
      messages.update(ms => ms.map(m =>
        m.role === 'tool' && m.running ? { ...m, running: false } : m
      ));
      if (ev.total_cost_usd != null) lastCost.set(ev.total_cost_usd);
      seenToolIds = new Set();
    }
  }

  // ── Slash commands (client-side only) ────────────────────────────────────
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
      case '/usage': {
        let c;
        lastCost.subscribe(v => c = v)();
        sysMsg(c != null ? `session cost so far: $${c.toFixed(4)}` : 'no cost data yet — complete a turn first');
        return true;
      }
      case '/btw':
        if (arg && ws?.readyState === 1)
          ws.send(JSON.stringify({ type: 'user', message: { role: 'user', content: arg } }));
        return true;
      default:
        return false;
    }
  }

  function onSend(e) {
    const text = e.detail;
    if (text.startsWith('/') && handleSlash(text)) return;
    if (ws?.readyState !== 1) return;
    messages.update(ms => [...ms, { id: uid(), role: 'user', text }]);
    ws.send(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }));
  }

  $: inputDisabled = !$wsOk;
  $: inputPlaceholder = !$wsOk ? 'Connecting…'
    : $hostStatus !== 'connected' ? 'Waiting for host…'
    : 'Message Claude… (/ for commands)';
</script>

<div class="layout">
  <header>
    <span class="brand">claude</span>
    <div class="indicators">
      <span class="dot" class:on={$hostStatus === 'connected'}>host</span>
      <span class="dot" class:on={$wsOk}>ws</span>
      {#if $lastCost != null}
        <span class="cost">${$lastCost.toFixed(4)}</span>
      {/if}
    </div>
    <button class="hc-toggle" on:click={() => highContrast.update(v => !v)}
      title="Toggle high contrast" aria-pressed={$highContrast}>HC</button>
    <button class="logout" on:click={() => dispatch('logout')}>logout</button>
  </header>

  <MessageList hostStatus={$hostStatus} />

  <ChatInput
    disabled={inputDisabled}
    placeholder={inputPlaceholder}
    on:send={onSend}
  />
</div>

<style>
  .layout { display: flex; flex-direction: column; height: var(--app-height, 100dvh); }

  header {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 16px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .brand { color: var(--accent); font-weight: 600; font-size: .88rem; flex: 1; }
  .indicators { display: flex; align-items: center; gap: 8px; }
  .dot { font-size: .72rem; color: var(--text-dim); }
  .dot.on { color: #5a5; }
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
