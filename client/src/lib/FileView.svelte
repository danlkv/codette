<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { renderMd } from '../utils/markdown.js';
  import { sessions, currentSessionId } from '../store.js';

  let { sessionId = null, path = '', token = null, onClose } = $props();

  let content = $state(null);
  let error = $state(null);
  let loading = $state(true);

  let sessionCwd = $derived($sessions.find(s => s.id === $currentSessionId)?.cwd ?? null);
  let relativePath = $derived((sessionCwd && path.startsWith(sessionCwd))
    ? path.slice(sessionCwd.length).replace(/^\//, '')
    : path);
  let isMarkdown = $derived(/\.md$/i.test(path));
  let renderedHtml = $derived(isMarkdown && content ? renderMd(content) : null);

  $effect(() => {
    if (path) fetchFile();
  });

  async function fetchFile() {
    loading = true;
    error = null;
    content = null;
    try {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.error) {
        error = data.error;
      } else if (data.content === null) {
        error = '[binary file]';
      } else {
        content = data.content;
      }
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }
</script>

<div class="file-view">
  <div class="fv-header">
    <span class="fv-path" title={path}>{relativePath}</span>
    <button class="fv-close" onclick={onClose} title="Close file view" aria-label="Close">×</button>
  </div>

  <div class="fv-body">
    {#if loading}
      <div class="fv-status">loading…</div>
    {:else if error}
      <div class="fv-status fv-error">{error}</div>
    {:else if renderedHtml}
      <div class="fv-md">{@html renderedHtml}</div>
    {:else}
      <pre class="fv-pre">{content}</pre>
    {/if}
  </div>
</div>

<style>
  .file-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
    height: 100%;
  }

  .fv-header {
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

  .fv-path {
    font-size: .78rem;
    color: var(--text-muted);
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .fv-close {
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
  .fv-close:hover { color: var(--text); }

  .fv-body {
    flex: 1;
    overflow: auto;
    padding: 0;
  }

  .fv-status {
    padding: 16px;
    font-size: .8rem;
    color: var(--text-dim);
  }
  .fv-error { color: #e06c75; }

  .fv-pre {
    margin: 0;
    padding: 12px 16px;
    font-family: monospace;
    font-size: .78rem;
    line-height: 1.5;
    color: var(--text);
    white-space: pre;
    overflow: auto;
    min-height: 100%;
    box-sizing: border-box;
  }

  .fv-md {
    padding: 16px 20px;
    color: var(--text);
    font-size: .85rem;
    line-height: 1.7;
  }
  .fv-md :global(h1),
  .fv-md :global(h2),
  .fv-md :global(h3),
  .fv-md :global(h4) {
    color: var(--text);
    margin: 1.2em 0 .4em;
    line-height: 1.3;
  }
  .fv-md :global(h1) { font-size: 1.4rem; }
  .fv-md :global(h2) { font-size: 1.15rem; }
  .fv-md :global(h3) { font-size: 1rem; }
  .fv-md :global(p) { margin: .5em 0; }
  .fv-md :global(code) {
    font-family: monospace;
    font-size: .82em;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: .1em .35em;
  }
  .fv-md :global(pre) {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px 14px;
    overflow-x: auto;
    margin: .6em 0;
  }
  .fv-md :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    font-size: .78rem;
  }
  .fv-md :global(ul),
  .fv-md :global(ol) { padding-left: 1.5em; margin: .4em 0; }
  .fv-md :global(li) { margin: .2em 0; }
  .fv-md :global(blockquote) {
    border-left: 3px solid var(--border);
    margin: .5em 0;
    padding: .2em .8em;
    color: var(--text-muted);
  }
  .fv-md :global(a) { color: var(--accent-light); }
  .fv-md :global(hr) { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
  .fv-md :global(table) { border-collapse: collapse; width: 100%; margin: .6em 0; }
  .fv-md :global(th),
  .fv-md :global(td) {
    border: 1px solid var(--border);
    padding: 4px 10px;
    font-size: .8rem;
  }
  .fv-md :global(th) { background: var(--bg-elevated); }
</style>
