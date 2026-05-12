<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { relativeTime } from '../utils/time.js';

  let { sessionId = null, sessionCwd = null, token = null, onDiffOpen } = $props();

  let changesOpen = $state(localStorage.getItem('claudeweb_gitChanges') === 'true');
  let logOpen     = $state(localStorage.getItem('claudeweb_gitLog') === 'true');
  $effect(() => { localStorage.setItem('claudeweb_gitChanges', changesOpen ? 'true' : 'false'); });
  $effect(() => { localStorage.setItem('claudeweb_gitLog', logOpen ? 'true' : 'false'); });

  let changesLoading = $state(false);
  let changesError   = $state(null);
  let files          = $state([]);

  let logLoading = $state(false);
  let logError   = $state(null);
  let commits    = $state([]);
  let branch     = $state(null);

  // Reset when session changes
  let prevSessionId = null;
  $effect(() => {
    if (sessionId !== prevSessionId) {
      const first = prevSessionId === null;
      prevSessionId = sessionId;
      files = []; changesError = null;
      commits = []; logError = null; branch = null;
      if (!first) { changesOpen = false; logOpen = false; }
      else {
        if (changesOpen) fetchStatus();
        if (logOpen) fetchLog();
      }
    }
  });

  async function fetchStatus() {
    if (!sessionId || !token) return;
    changesLoading = true;
    changesError = null;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.error) { changesError = data.error; files = []; }
      else { files = data.files ?? []; }
    } catch (e) {
      changesError = String(e); files = [];
    } finally {
      changesLoading = false;
    }
  }

  async function fetchLog() {
    if (!sessionId || !token) return;
    logLoading = true;
    logError = null;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/log`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.error) { logError = data.error; commits = []; branch = null; }
      else {
        commits = data.commits ?? [];
        branch = data.branch ?? null;
        if (commits.length === 0) logError = 'no commits';
      }
    } catch (e) {
      logError = String(e); commits = [];
    } finally {
      logLoading = false;
    }
  }

  function toggleChanges() {
    changesOpen = !changesOpen;
    if (changesOpen && files.length === 0 && !changesLoading) fetchStatus();
  }

  function toggleLog() {
    logOpen = !logOpen;
    if (logOpen && commits.length === 0 && !logLoading) fetchLog();
  }

  function refreshChanges(e) { e.stopPropagation(); fetchStatus(); }
  function refreshLog(e)     { e.stopPropagation(); fetchLog(); }

  function openDiff(c) { onDiffOpen?.({ sessionId, commit: c.hash }); }

  function charColor(ch, staged = false) {
    if (ch === 'M' || ch === 'U') return staged ? 'add' : 'mod';
    if (ch === 'A') return 'add';
    if (ch === 'D') return 'del';
    if (ch === '?') return 'unk';
    return 'dim';
  }
</script>

{#if sessionCwd}
  <div class="git-section">
    <div class="gs-outer-header">
      <span class="gs-label">Git</span>
      {#if branch}<span class="gs-branch">{branch}</span>{/if}
    </div>

    <!-- Changes subsection -->
    <div class="subsection">
      <div class="sub-header-row">
        <button class="sub-header" onclick={toggleChanges}>
          <span class="toggle">{changesOpen ? '▼' : '▶'}</span>
          <span>Status</span>
          {#if files.length > 0}<span class="badge">{files.length}</span>{/if}
        </button>
        <button class="sub-refresh" onclick={refreshChanges} title="Refresh" aria-label="Refresh changes">↺</button>
      </div>
      {#if changesOpen}
        <div class="sub-list">
          {#if changesLoading}
            <span class="info">…</span>
          {:else if changesError}
            <span class="info dim">not a git repo</span>
          {:else if files.length === 0}
            <span class="info dim">clean</span>
          {:else}
            {#each files as f (f.path)}
              {#if f.xy.trim() === '??'}
                <div class="file-row">
                  <span class="xy-x unk">?</span><span class="xy-y unk">?</span>
                  <span class="fpath">{f.path}</span>
                </div>
              {:else}
                <button class="file-row clickable" onclick={() => onDiffOpen?.({ sessionId, file: f.path })}>
                  <span class="xy-x {charColor(f.xy[0], true)}">{f.xy[0]}</span><span class="xy-y {charColor(f.xy[1])}">{f.xy[1]}</span>
                  <span class="fpath">{f.path}</span>
                </button>
              {/if}
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Log subsection -->
    <div class="subsection">
      <div class="sub-header-row">
        <button class="sub-header" onclick={toggleLog}>
          <span class="toggle">{logOpen ? '▼' : '▶'}</span>
          <span>Log</span>
        </button>
        <button class="sub-refresh" onclick={refreshLog} title="Refresh" aria-label="Refresh log">↺</button>
      </div>
      {#if logOpen}
        <div class="sub-list">
          {#if logLoading}
            <span class="info">…</span>
          {:else if logError}
            <span class="info dim">{logError === 'no commits' ? 'no commits' : 'not a git repo'}</span>
          {:else}
            {#each commits as c (c.hash)}
              <button class="commit-row" onclick={() => openDiff(c)}>
                <span class="hash">{c.hash.slice(0, 7)}</span>
                <span class="subject">{c.subject}</span>
                <span class="date">{relativeTime(c.date)}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .git-section {
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }

  .gs-outer-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px 4px;
  }
  .gs-label {
    font-size: .7rem;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .gs-branch {
    font-size: .7rem;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subsection {
    border-top: 1px solid var(--border-subtle, var(--border));
  }

  .sub-header-row {
    display: flex;
    align-items: center;
  }
  .sub-header {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px 4px 16px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-dim);
    font: inherit;
    font-size: .7rem;
    text-align: left;
    transition: color .15s;
    min-width: 0;
  }
  .sub-header:hover { color: var(--text); }

  .sub-refresh {
    flex-shrink: 0;
    padding: 4px 10px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-dim);
    font-size: .85rem;
    line-height: 1;
    transition: color .15s;
  }
  .sub-refresh:hover { color: var(--accent-light); }

  .toggle {
    font-size: .55rem;
    flex-shrink: 0;
  }

  .badge {
    font-size: .65rem;
    color: var(--accent-light);
    margin-left: 2px;
  }

  .sub-list {
    overflow-y: auto;
    max-height: 160px;
    padding-bottom: 4px;
  }

  .info {
    display: block;
    padding: 3px 16px;
    font-size: .72rem;
    color: var(--text-dim);
  }
  .info.dim { font-style: italic; }

  /* Changes */
  .file-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 12px 2px 16px;
    font-size: .72rem;
    min-width: 0;
  }
  button.file-row {
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    font: inherit;
    font-size: .72rem !important;
    text-align: left;
    transition: background .1s;
  }
  button.file-row:hover { background: var(--bg-elevated); }
  button.file-row:hover .fpath { color: var(--text); }
  .xy-x, .xy-y {
    font-family: monospace;
    font-size: .7rem;
    flex-shrink: 0;
    width: .7em;
    text-align: center;
  }
  .xy-x.mod, .xy-y.mod { color: var(--warning, #e5c07b); }
  .xy-x.add, .xy-y.add { color: #98c379; }
  @media (prefers-color-scheme: light) {
    .xy-x.add, .xy-y.add { color: #388203; }
  }
  .xy-x.del, .xy-y.del { color: var(--error); }
  .xy-x.unk, .xy-y.unk { color: var(--text-dim); }
  .xy-x.dim, .xy-y.dim { color: var(--text-dim); opacity: .3; }
  .fpath {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    min-width: 0;
  }

  /* Log */
  .commit-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    padding: 3px 12px 3px 16px;
    background: none;
    border: none;
    cursor: pointer;
    font: inherit;
    font-size: .72rem;
    text-align: left;
    color: var(--text-muted);
    transition: background .1s;
    min-width: 0;
  }
  .commit-row:hover {
    background: var(--bg-elevated);
    color: var(--text);
  }

  .hash {
    font-family: monospace;
    font-size: .7rem;
    color: var(--accent-light);
    flex-shrink: 0;
    letter-spacing: .02em;
  }
  .subject {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .date {
    flex-shrink: 0;
    font-size: .65rem;
    color: var(--text-dim);
    margin-left: auto;
    white-space: nowrap;
  }
</style>
