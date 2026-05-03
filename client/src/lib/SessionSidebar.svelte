<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { createEventDispatcher } from 'svelte';
  export let sessions = [];   // [{id, title, ts, active}]
  export let currentId = null;
  export let open = true;

  const dispatch = createEventDispatcher();

  let confirmingId = null;
  let confirmTimer = null;

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
</script>

<aside class="sidebar" class:hidden={!open}>
  <div class="sidebar-header">Sessions</div>
  <div class="list">
    {#each sessions as s (s.id)}
      <div class="session-row" class:active={s.id === currentId}>
        <button class="session" on:click={() => resume(s.id)} title={s.id}>
          <span class="meta">
            {#if s.id === currentId}<span class="dot"></span>{/if}
            <span class="time">{fmt(s.ts)}</span>
            {#if s.msgCount}<span class="count">{s.msgCount}</span>{/if}
          </span>
          <span class="title">{s.title || s.id.slice(0, 8)}</span>
        </button>
        <button
          class="del" class:confirming={confirmingId === s.id}
          on:click={(e) => tryDelete(e, s.id)}
          title="Delete session"
          aria-label="Delete session"
        >{confirmingId === s.id ? '?' : '×'}</button>
      </div>
    {/each}
    {#if sessions.length === 0}
      <p class="empty">No sessions</p>
    {/if}
  </div>
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
  .sidebar-header {
    padding: 10px 12px 6px;
    font-size: .7rem;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
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

  .meta {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent-light);
    flex-shrink: 0;
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
