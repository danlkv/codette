<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  let { sessionId = null, commit = null, token = null, onClose } = $props();

  let loading = $state(true);
  let error = $state(null);
  let diffText = $state(null);

  let shortHash = $derived(commit ? commit.slice(0, 7) : '');
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
    if (!sessionId || !commit || !token) return;
    loading = true;
    error = null;
    diffText = null;
    try {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/git/diff?commit=${encodeURIComponent(commit)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.error) {
        error = data.error;
      } else {
        diffText = data.diff ?? '';
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
    <span class="dv-commit" title={commit}>{shortHash}</span>
    <button class="dv-close" onclick={onClose} title="Close diff view" aria-label="Close">×</button>
  </div>

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
  .dv-error { color: #e06c75; }

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
  .diff :global(.del) {
    display: block;
    color: #e06c75;
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
