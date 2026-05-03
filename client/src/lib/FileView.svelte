<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { onMount, createEventDispatcher } from 'svelte';
  import { sessions, currentSessionId } from '../store.js';

  export let sessionId = null;
  export let path = '';
  export let token = null;

  const dispatch = createEventDispatcher();

  let content = null;
  let error = null;
  let loading = true;

  // Derive relative path from store
  $: sessionCwd = $sessions.find(s => s.id === $currentSessionId)?.cwd ?? null;
  $: relativePath = (sessionCwd && path.startsWith(sessionCwd))
    ? path.slice(sessionCwd.length).replace(/^\//, '')
    : path;

  onMount(async () => {
    await fetchFile();
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

  function close() {
    dispatch('close');
  }
</script>

<div class="file-view">
  <div class="fv-header">
    <span class="fv-path" title={path}>{relativePath}</span>
    <button class="fv-close" on:click={close} title="Close file view" aria-label="Close">×</button>
  </div>

  <div class="fv-body">
    {#if loading}
      <div class="fv-status">loading…</div>
    {:else if error}
      <div class="fv-status fv-error">{error}</div>
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
</style>
