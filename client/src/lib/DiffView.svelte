<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { fetchGitDiff, fetchGitFileDiff } from '../utils/api.js';

  let { sessionId = null, commit = null, file = null, token = null, onClose } = $props();

  let loading = $state(true);
  let error = $state(null);
  let diffText = $state(null);
  let stat = $state([]);

  let shortHash = $derived(commit ? commit.slice(0, 7) : '');
  let title = $derived(file ? file.split('/').pop() : shortHash);
  let diffHtml = $derived(diffText ? buildDiffHtml(diffText) : '');

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildDiffHtml(text) {
    return text.split('\n').map(line => {
      const esc = escapeHtml(line);
      if (line.startsWith('+++') || line.startsWith('---')) {
        return `<span class="meta">${esc}</span>`;
      } else if (line.startsWith('+')) {
        return `<span class="add">${esc}</span>`;
      } else if (line.startsWith('-')) {
        return `<span class="del">${esc}</span>`;
      } else if (line.startsWith('@@')) {
        return `<span class="hunk">${esc}</span>`;
      } else {
        return `<span>${esc}</span>`;
      }
    }).join('');
  }

  $effect(() => {
    fetchDiff();
  });

  async function fetchDiff() {
    if (!sessionId || !token || (!commit && !file)) return;
    loading = true;
    error = null;
    diffText = null;
    stat = [];
    try {
      const data = file
        ? await fetchGitFileDiff(sessionId, file, token)
        : await fetchGitDiff(sessionId, commit, token);
      if (data.error) {
        error = data.error;
      } else {
        diffText = data.diff ?? '';
        stat = data.stat ?? [];
      }
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }
</script>

<div class="diff-view">
  <div class="dv-header">
    <span class="dv-commit" title={file ?? commit}>{title}</span>
    <button class="dv-close" onclick={onClose} title="Close diff view" aria-label="Close">×</button>
  </div>
  {#if !file && stat.length > 0}
    <div class="dv-section-header">Summary</div>
    <div class="dv-stat">
      {#each stat as f (f.path)}
        <div class="stat-row">
          <span class="stat-path">{f.path}</span>
          {#if f.added !== 0}<span class="stat-add">+{f.added}</span>{/if}
          {#if f.deleted !== 0}<span class="stat-del">-{f.deleted}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}

  <div class="dv-section-header">Full diff</div>
  <div class="dv-body">
    {#if loading}
      <div class="dv-status">Loading diff…</div>
    {:else if error}
      <div class="dv-status dv-error">{error}</div>
    {:else}
      <pre class="diff">{@html diffHtml}</pre>
    {/if}
  </div>
</div>

<style>
  .diff-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
    height: 100%;
  }

  .dv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: 8px;
    min-width: 0;
  }

  .dv-commit {
    font-family: monospace;
    font-size: .78rem;
    color: var(--accent-light);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    letter-spacing: .02em;
  }

  .dv-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-dim);
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 2px;
    flex-shrink: 0;
    transition: color .15s;
  }
  .dv-close:hover { color: var(--text); }

  .dv-section-header {
    font-size: .65rem;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--text-dim);
    padding: 5px 12px 3px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .dv-stat {
    overflow-y: auto;
    max-height: 120px;
    padding: 4px 0;
    flex-shrink: 0;
  }
  .stat-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 12px;
    font-family: monospace;
    font-size: .72rem;
    min-width: 0;
  }
  .stat-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    min-width: 0;
  }
  .stat-add { color: #98c379; flex-shrink: 0; }
  @media (prefers-color-scheme: light) {
    .stat-add { color: #388203; }
  }
  .stat-del { color: var(--error); flex-shrink: 0; }

  .dv-body {
    flex: 1;
    overflow: auto;
    padding: 0;
  }

  .dv-status {
    padding: 16px;
    font-size: .8rem;
    color: var(--text-dim);
  }
  .dv-error { color: var(--error); }

  .diff {
    margin: 0;
    padding: 12px 16px;
    font-family: monospace;
    font-size: .75rem;
    line-height: 1.5;
    color: var(--text);
    white-space: pre;
    overflow: auto;
    min-height: 100%;
    box-sizing: border-box;
  }

  .diff :global(.add) {
    display: block;
    color: #98c379;
    background: rgba(152, 195, 121, .08);
  }
  @media (prefers-color-scheme: light) {
    .diff :global(.add) { color: #388203; background: rgba(56, 130, 3, .08); }
  }
  .diff :global(.del) {
    display: block;
    color: var(--error);
    background: rgba(224, 108, 117, .08);
  }
  .diff :global(.hunk) {
    display: block;
    color: var(--accent-light);
  }
  .diff :global(.meta) {
    display: block;
    color: var(--text-muted);
  }
  .diff :global(span) {
    display: block;
  }
</style>
