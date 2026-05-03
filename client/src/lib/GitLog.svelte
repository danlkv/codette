<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { relativeTime } from '../utils/time.js';

  let { sessionId = null, sessionCwd = null, token = null, onDiffOpen } = $props();

  let sectionOpen = $state(false);
  let loading = $state(false);
  let error = $state(null);
  let commits = $state([]);
  let branch = $state(null);

  // Reset when sessionId changes
  let prevSessionId = null;
  $effect(() => {
    if (sessionId !== prevSessionId) {
      prevSessionId = sessionId;
      commits = [];
      branch = null;
      error = null;
      sectionOpen = false;
    }
  });

  async function fetchLog() {
    if (!sessionId || !token) return;
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/log`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.error) {
        error = data.error;
        commits = [];
        branch = null;
      } else {
        commits = data.commits ?? [];
        branch = data.branch ?? null;
        if (commits.length === 0) error = 'no commits';
      }
    } catch (e) {
      error = String(e);
      commits = [];
    } finally {
      loading = false;
    }
  }

  function toggleSection() {
    sectionOpen = !sectionOpen;
    if (sectionOpen && commits.length === 0 && !loading) {
      fetchLog();
    }
  }

  function refresh(e) {
    e.stopPropagation();
    fetchLog();
  }

  function openDiff(c) {
    onDiffOpen?.({ sessionId, commit: c.hash });
  }
</script>

{#if sessionCwd}
  <div class="git-log">
    <div class="gl-header-row">
      <button class="gl-header" onclick={toggleSection}>
        <span class="toggle">{sectionOpen ? '▼' : '▶'}</span>
        <span class="label">Git</span>
        {#if branch}
          <span class="branch">{branch}</span>
        {/if}
      </button>
      <button class="gl-refresh" onclick={refresh} title="Refresh git log" aria-label="Refresh">↺</button>
    </div>

    {#if sectionOpen}
      <div class="gl-list">
        {#if loading}
          <span class="info">…</span>
        {:else if error}
          <span class="info dim">{error === 'no commits' ? 'no commits' : 'not a git repo'}</span>
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
{/if}

<style>
  .git-log {
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }

  .gl-header-row {
    display: flex;
    align-items: center;
  }

  .gl-header {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 7px 8px 5px 12px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font: inherit;
    font-size: .7rem;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    text-align: left;
    transition: color .15s;
    min-width: 0;
  }
  .gl-header:hover { color: var(--text); }

  .gl-refresh {
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
  .gl-refresh:hover { color: var(--accent-light); }

  .toggle {
    font-size: .58rem;
    color: var(--text-dim);
    flex-shrink: 0;
  }
  .label { color: var(--text-muted); }
  .branch {
    color: var(--text-dim);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gl-list {
    overflow-y: auto;
    max-height: 240px;
    padding-bottom: 4px;
  }

  .info {
    display: block;
    padding: 4px 16px;
    font-size: .72rem;
    color: var(--text-dim);
  }
  .info.dim { font-style: italic; }

  .commit-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    padding: 3px 12px;
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
