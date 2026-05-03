<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { createEventDispatcher } from 'svelte';
  import FileExplorer from './FileExplorer.svelte';

  export let sessions = [];   // [{id, title, ts, msgCount, agentActive, cwd}]
  export let currentId = null;
  export let open = true;
  export let hostCwd = null;
  export let sessionId = null;
  export let token = null;

  $: currentSessionCwd = sessions.find(s => s.id === currentId)?.cwd ?? null;

  const dispatch = createEventDispatcher();

  let confirmingId = null;
  let confirmTimer = null;
  let showNew = false;
  let newCwd = '';

  $: if (showNew && !newCwd && hostCwd) newCwd = hostCwd;

  function fmt(ts) {
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - ts;
    if (diff < 86_400_000)  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diff < 7*86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function resume(id) {
    confirmingId = null;
    dispatch('resume', id);
  }

  function startNew() {
    dispatch('new_session', newCwd.trim() || null);
    showNew = false;
    newCwd = hostCwd || '';
  }

  function tryDelete(e, id) {
    e.stopPropagation();
    if (confirmingId === id) {
      clearTimeout(confirmTimer);
      confirmingId = null;
      dispatch('delete', id);
    } else {
      confirmingId = id;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => confirmingId = null, 4000);
    }
  }

  function interrupt(e, id) {
    e.stopPropagation();
    dispatch('agent_ctl', { id, event: 'interrupt' });
  }

  function stop(e, id) {
    e.stopPropagation();
    dispatch('agent_ctl', { id, event: 'stop' });
  }
</script>

<aside class="sidebar" class:hidden={!open}>
  <div class="sidebar-header">
    <span>Sessions</span>
    <button class="new-btn" on:click={() => showNew = !showNew} title="New session" aria-pressed={showNew}>+</button>
  </div>
  {#if showNew}
    <form class="new-form" on:submit|preventDefault={startNew}>
      <input class="new-input" bind:value={newCwd} placeholder="/path/to/project" autofocus />
      <button class="new-start" type="submit">Start</button>
    </form>
  {/if}
  <div class="list">
    {#each sessions as s (s.id)}
      <div class="session-row" class:active={s.id === currentId}>
        <button class="session" on:click={() => resume(s.id)} title={s.id}>
          <span class="meta">
            {#if s.agentState === 'idle'}
              <span class="dot standby"></span>
            {:else if s.agentState === 'running'}
              <span class="dot running"></span>
            {/if}
            <span class="time">{fmt(s.ts)}</span>
            {#if s.msgCount}<span class="count">{s.msgCount}</span>{/if}
          </span>
          <span class="title">{s.title || s.id.slice(0, 8)}</span>
        </button>

        {#if s.agentState}
          <button
            class="ctl interrupt"
            on:click={(e) => interrupt(e, s.id)}
            title="Interrupt agent"
            aria-label="Interrupt agent"
          >⊘</button>
          <button
            class="ctl stop"
            on:click={(e) => stop(e, s.id)}
            title="Stop agent"
            aria-label="Stop agent"
          >■</button>
        {:else}
          <button
            class="del" class:confirming={confirmingId === s.id}
            on:click={(e) => tryDelete(e, s.id)}
            title="Delete session"
            aria-label="Delete session"
          >{confirmingId === s.id ? '?' : '×'}</button>
        {/if}
      </div>
    {/each}
    {#if sessions.length === 0}
      <p class="empty">No sessions</p>
    {/if}
  </div>

  <FileExplorer
    {sessionId}
    sessionCwd={currentSessionCwd}
    {token}
    on:file-open
  />
</aside>

<style>
  .sidebar.hidden { display: none; }
  .sidebar {
    width: 300px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  @media (max-width: 640px) {
    .sidebar, .sidebar.hidden {
      display: flex;
      position: absolute;
      top: 0; left: 0;
      height: 100%;
      z-index: 50;
      transform: translateX(-100%);
      transition: transform .04s ease;
      box-shadow: 2px 0 12px rgba(0,0,0,.4);
    }
    .sidebar:not(.hidden) {
      transform: translateX(0);
    }
  }
  .sidebar-header {
    padding: 10px 12px 6px;
    font-size: .7rem;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .new-btn {
    background: none; border: none; cursor: pointer;
    color: var(--text-dim); font-size: 1.1rem; line-height: 1;
    padding: 0 2px; transition: color .15s;
  }
  .new-btn:hover, .new-btn[aria-pressed="true"] { color: var(--accent-light); }
  .new-form {
    display: flex; gap: 4px; padding: 6px 8px;
    border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .new-input {
    flex: 1; min-width: 0;
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text); font: inherit; font-size: .75rem;
    padding: 4px 7px; outline: none;
  }
  .new-input:focus { border-color: var(--accent-light); }
  .new-start {
    background: var(--accent); border: none; border-radius: 4px;
    color: #fff; cursor: pointer; font: inherit; font-size: .72rem;
    padding: 4px 8px; flex-shrink: 0; transition: opacity .15s;
  }
  .new-start:hover { opacity: .85; }
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .session-row {
    display: flex;
    align-items: stretch;
    border-left: 2px solid transparent;
  }
  .session-row.active {
    border-left-color: var(--accent-light);
    background: var(--bg-elevated);
  }
  .session-row:active { background: var(--bg-elevated); }

  .session {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 8px 8px 12px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--text-muted);
    font: inherit;
    font-size: .78rem;
  }
  .session-row.active .session { color: var(--text); }

  .del {
    flex-shrink: 0;
    width: 36px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-dim);
    font-size: 1rem;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: color .15s;
  }
  .del:active { color: var(--text-muted); }
  .del.confirming { color: #e06c75; font-weight: 700; }

  /* Agent control buttons */
  .ctl {
    flex-shrink: 0;
    width: 28px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: .85rem;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: color .15s;
  }
  .ctl.interrupt { color: var(--text-dim); }
  .ctl.interrupt:hover { color: #e5c07b; }
  .ctl.stop { color: var(--text-dim); }
  .ctl.stop:hover { color: #e06c75; }

  .meta {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.standby { background: #5a5; }
  .dot.running {
    background: var(--accent-light);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%   { opacity: 1;   transform: scale(1); }
    50%  { opacity: .45; transform: scale(1.35); }
    100% { opacity: 1;   transform: scale(1); }
  }

  .time { font-size: .7rem; color: var(--text-dim); }
  .count { font-size: .65rem; color: var(--text-dim); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; padding: 0 5px; }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: .78rem;
  }
  .empty {
    padding: 12px;
    font-size: .75rem;
    color: var(--text-dim);
    text-align: center;
    margin: 0;
  }
</style>
