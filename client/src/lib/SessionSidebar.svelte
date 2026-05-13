<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { fmtAge } from '../utils/time.js';
  import { getSettings, saveSettings } from '../utils/storage.js';
  import FileExplorer from './FileExplorer.svelte';
  import GitLog from './GitLog.svelte';

  let {
    sessions = [],
    currentId = null,
    open = true,
    hostCwd = null,
    sessionId = null,
    token = null,
    showFileChips = true,
    onSelect,
    onDelete,
    onNewSession,
    onAgentCtl,
    onFileOpen,
    onDiffOpen,
  } = $props();

  let currentSessionCwd = $derived(sessions.find(s => s.id === currentId)?.cwd ?? null);

  let confirmingId = $state(null);
  let confirmTimer = $state(null);
  let showNew = $state(false);
  let newCwd = $state('');
  let inlineFiles = $state(getSettings('inlineFiles'));

  let menuId = $state(null);
  let menuName = $state('');

  $effect(() => {
    if (showNew && !newCwd && hostCwd) newCwd = hostCwd;
  });

  $effect(() => {
    if (!menuId) return;
    function onDocClick(e) {
      if (!e.target.closest('.session-menu') && !e.target.closest('.ctl.more')) menuId = null;
    }
    document.addEventListener('click', onDocClick, true);
    return () => document.removeEventListener('click', onDocClick, true);
  });

  function select(id) {
    confirmingId = null;
    onSelect?.(id);
  }

  function startNew() {
    saveSettings('inlineFiles', inlineFiles);
    onNewSession?.(newCwd.trim() || null, { inlineFiles });
    showNew = false;
    newCwd = hostCwd || '';
  }

  function tryDelete(e, id) {
    e.stopPropagation();
    if (confirmingId === id) {
      clearTimeout(confirmTimer);
      confirmingId = null;
      menuId = null;
      onDelete?.(id);
    } else {
      confirmingId = id;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => confirmingId = null, 4000);
    }
  }

  function interrupt(e, id) {
    e.stopPropagation();
    onAgentCtl?.({ id, event: 'interrupt' });
    menuId = null;
  }

  function stop(e, id) {
    e.stopPropagation();
    onAgentCtl?.({ id, event: 'stop' });
    menuId = null;
  }

  function openMenu(e, s) {
    e.stopPropagation();
    if (menuId === s.id) { menuId = null; return; }
    menuId = s.id;
    menuName = s.name || s.title || s.id.slice(0, 8);
    confirmingId = null;
  }

  async function saveMenuName(id) {
    const v = menuName.trim();
    menuId = null;
    await fetch(`/api/sessions/${encodeURIComponent(id)}/name`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: v || null }),
    });
  }

  function menuNameKeydown(e, id) {
    if (e.key === 'Enter') { e.preventDefault(); saveMenuName(id); }
    if (e.key === 'Escape') { e.preventDefault(); menuId = null; }
  }
</script>

<aside class="sidebar" class:hidden={!open}>
  <div class="sidebar-header">
    <span>Sessions</span>
    <button class="new-btn" onclick={() => showNew = !showNew} title="New session" aria-pressed={showNew}>+</button>
  </div>
  {#if showNew}
    <form class="new-form" onsubmit={(e) => { e.preventDefault(); startNew(); }}>
      <input class="new-input" bind:value={newCwd} placeholder="/path/to/project" autofocus />
      <button class="new-start" type="submit">Start</button>
    </form>
    <label class="inline-files-toggle">
      <input type="checkbox" bind:checked={inlineFiles} />
      <span>instruct agent to use inline file viewer</span>
    </label>
  {/if}
  <div class="list">
    {#each sessions as s (s.id)}
      <div class="session-row" class:active={s.id === currentId}>
        <div class="row-wrap">
          <div class="row-top">
            <button class="session" onclick={() => select(s.id)} title={s.id}>
              <span class="meta">
                {#if s.agentState === 'idle'}
                  <span class="dot standby"></span>
                {:else if s.agentState === 'running'}
                  <span class="dot running"></span>
                {/if}
                <span class="time">{fmtAge(s.ts)}</span>
                {#if s.msgCount}<span class="count">{s.msgCount}</span>{/if}
                {#if s.cwd}<span class="cwd" title={s.cwd}>{s.cwd.split('/').filter(Boolean).pop() ?? s.cwd}</span>{/if}
              </span>
              <span class="title">{s.name || s.title || s.id.slice(0, 8)}</span>
            </button>
            <button class="ctl more" onclick={(e) => openMenu(e, s)}
              title="Session options" aria-label="Session options"
              class:open={menuId === s.id}
            >⋮</button>
          </div>

          {#if menuId === s.id}
            <div class="session-menu">
              <input class="menu-name" bind:value={menuName}
                placeholder="Session name"
                onkeydown={(e) => menuNameKeydown(e, s.id)}
              />
              <div class="menu-actions">
                {#if s.agentState}
                  <button class="menu-btn" onclick={(e) => interrupt(e, s.id)}>⊘ interrupt</button>
                  <button class="menu-btn warn" onclick={(e) => stop(e, s.id)}>■ stop</button>
                {/if}
                <button class="menu-btn danger" class:confirming={confirmingId === s.id}
                  onclick={(e) => tryDelete(e, s.id)}
                >{confirmingId === s.id ? 'confirm?' : '× delete'}</button>
              </div>
            </div>
          {/if}

          {#if showFileChips && s.files?.length}
            <div class="file-chips">
              {#each s.files as file}
                <button class="chip" title={file}
                  onclick={(e) => { e.stopPropagation(); select(s.id); onFileOpen?.({ path: file }); }}
                >{file.split('/').pop()}</button>
              {/each}
            </div>
          {/if}
        </div>
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
    {onFileOpen}
  />

  <GitLog
    {sessionId}
    sessionCwd={currentSessionCwd}
    {token}
    {onDiffOpen}
  />
</aside>

<style>
  .sidebar.hidden { display: none; }
  .sidebar {
    width: 360px;
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
  .inline-files-toggle {
    display: flex; align-items: center; gap: 5px;
    padding: 4px 8px 6px;
    font-size: .72rem; color: var(--text-dim);
    cursor: pointer;
  }
  .inline-files-toggle input { accent-color: var(--accent); cursor: pointer; }
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
  .row-wrap {
    display: flex; flex-direction: column;
    flex: 1; min-width: 0;
  }
  .row-top {
    display: flex; align-items: stretch;
  }
  .file-chips {
    display: flex; flex-wrap: wrap; gap: 3px;
    padding: 2px 10px 7px 14px;
    max-height: 44px;
    overflow: hidden;
    transition: max-height .15s ease;
  }
  .session-row.active .file-chips { max-height: 120px; }
  .chip {
    font-size: .73rem !important; font-family: inherit; color: var(--text-dim);
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 3px; padding: 1px 5px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 110px; cursor: pointer;
    transition: color .12s, border-color .12s;
  }
  .chip:hover { color: var(--text); border-color: var(--accent-light); }
  .session-row.active .chip { color: var(--text-muted); border-color: #333; }
  .session-row.active .chip:hover { color: var(--text); border-color: var(--accent-light); }
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

  .ctl {
    flex-shrink: 0;
    width: 32px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    letter-spacing: .05em;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: color .15s, opacity .15s;
  }
  .ctl.more {
    color: var(--text-dim);
  }
  .ctl.more:hover, .ctl.more.open { color: var(--text); }

  .session-menu {
    padding: 6px 10px 8px 12px;
    border-top: 1px solid var(--border-subtle, var(--border));
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .menu-name {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font: inherit;
    font-size: .78rem;
    padding: 4px 8px;
    outline: none;
    width: 100%;
    box-sizing: border-box;
  }
  .menu-name:focus { border-color: var(--accent); }
  .menu-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .menu-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-dim);
    cursor: pointer;
    font: inherit;
    font-size: .72rem;
    padding: 3px 8px;
    transition: color .12s, border-color .12s, background .12s;
  }
  .menu-btn:hover { color: var(--text); border-color: var(--text-dim); }
  .menu-btn.warn { color: #e5c07b; }
  .menu-btn.warn:hover { border-color: #e5c07b; }
  .menu-btn.danger { color: var(--error); }
  .menu-btn.danger:hover { border-color: var(--error); }
  .menu-btn.confirming { background: var(--error); color: #fff; border-color: var(--error); }

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
  .dot.standby { background: var(--status-ok); }
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
  .cwd { font-size: .65rem; color: var(--text-dim); max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
