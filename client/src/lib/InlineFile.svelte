<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { onMount } from 'svelte';
  import SourceFileBlock from './SourceFileBlock.svelte';
  import ImagePreview from './ImagePreview.svelte';

  let { path, ranges = [], annotations = [], sessionId, token, onOpenFile = null, messageTime = null } = $props();

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tiff', 'tif', 'svg']);
  const ext = path.split('.').pop().toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  const isPdf = ext === 'pdf';
  const isBinary = isImage || isPdf;

  let imgSrc = $state(null);
  let error = $state(null);
  let loading = $state(isBinary);
  let containerEl = $state(null);

  onMount(() => {
    if (!isBinary) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        fetchBinary();
      }
    }, { threshold: 0.1 });
    observer.observe(containerEl);
    return () => observer.disconnect();
  });

  async function fetchBinary() {
    try {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await resp.json();
      if (data.error) { error = data.error; return; }
      if (data.base64) imgSrc = `data:${data.mimeType};base64,${data.base64}`;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function copyPath() {
    navigator.clipboard.writeText(path).catch(() => {});
  }
</script>

{#if isBinary}
  <div class="if-block" bind:this={containerEl}>
    <div class="if-header">
      <span class="if-path" title={path}>{path}</span>
      {#if onOpenFile}
        <button class="if-btn" onclick={() => onOpenFile(path)} title="View full file">view file</button>
      {/if}
      <button class="if-btn" onclick={copyPath} title="Copy path">copy path</button>
    </div>
    <div class="if-body">
      {#if loading}
        <div class="if-status">loading…</div>
      {:else if error}
        <div class="if-status if-error">{error}</div>
      {:else if isImage && imgSrc}
        <ImagePreview src={imgSrc} alt={path} />
      {:else if isPdf}
        <div class="if-status">pdf — use "view file" to open</div>
      {/if}
    </div>
  </div>
{:else}
  <SourceFileBlock {path} {ranges} {annotations} {sessionId} {token} {onOpenFile} {messageTime} />
{/if}

<style>
  .if-block {
    border: 1px solid var(--border);
    border-radius: 5px;
    margin: .5em 0;
    overflow: hidden;
    font-family: monospace;
    font-size: .85em;
  }

  .if-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    padding: 4px 10px;
    gap: 8px;
  }

  .if-path {
    color: var(--text-muted);
    font-size: .8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .if-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
    cursor: pointer;
    font: inherit;
    font-size: .8em;
    padding: 3px 8px;
    flex-shrink: 0;
    transition: color .15s, border-color .15s;
  }
  .if-btn:hover { color: var(--accent-light); border-color: var(--accent); }

  .if-body {
    background: var(--bg-primary);
  }

  .if-status {
    padding: 10px 12px;
    color: var(--text-dim);
    font-style: italic;
    font-size: .85em;
  }
  .if-error { color: var(--error); font-style: normal; }
</style>
