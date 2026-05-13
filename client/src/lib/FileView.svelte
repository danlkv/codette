<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { renderMd } from '../utils/markdown.js';
  import { fetchFile as apiFetchFile } from '../utils/api.js';
  import { mermaidRender } from '../utils/mermaid-action.js';
  import { syntaxHighlight } from '../utils/syntax-highlight-action.js';
  import { sessions, currentSessionId, effectiveSyntaxTheme } from '../store.js';
  import { highlightLines, langFromPath } from '../utils/highlight.js';
  import ImagePreview from './ImagePreview.svelte';

  let { sessionId = null, path = '', token = null, onClose } = $props();

  let content = $state(null);
  let base64 = $state(null);
  let mimeType = $state(null);
  let error = $state(null);
  let loading = $state(true);
  let hlHtml = $state(null);
  let pdfPages = $state(null); // array of canvas elements after render

  let sessionCwd = $derived($sessions.find(s => s.id === $currentSessionId)?.cwd ?? null);
  let relativePath = $derived((sessionCwd && path.startsWith(sessionCwd))
    ? path.slice(sessionCwd.length).replace(/^\//, '')
    : path);
  let isMarkdown = $derived(/\.md$/i.test(path));
  let isImage = $derived(!!mimeType && mimeType.startsWith('image/'));
  let isPdf = $derived(mimeType === 'application/pdf');
  let renderedHtml = $derived(isMarkdown && content ? renderMd(content) : null);

  $effect(() => {
    const theme = $effectiveSyntaxTheme;
    if (!theme || !content || isMarkdown) { hlHtml = null; return; }
    const lang = langFromPath(path);
    highlightLines(content, lang, theme)
      .then(({ lines }) => { hlHtml = lines.join('\n'); })
      .catch(() => { hlHtml = null; });
  });

  // Render PDF when base64 arrives
  $effect(() => {
    if (!isPdf || !base64) { pdfPages = null; return; }
    renderPdf(base64).catch(e => { error = String(e); pdfPages = null; });
  });

  $effect(() => {
    if (path) fetchFile();
  });

  async function fetchFile() {
    loading = true;
    error = null;
    content = null;
    base64 = null;
    mimeType = null;
    pdfPages = null;
    pdfScale = 1.5;
    pdfDoc = null;
    pdfNumPages = 0;
    try {
      const data = await apiFetchFile(sessionId, path, token);
      if (data.error) {
        error = data.error;
      } else if (data.base64) {
        base64 = data.base64;
        mimeType = data.mimeType;
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

  let pdfScale = $state(1.5);
  let pdfNumPages = $state(0);
  let pdfDoc = null;    // loaded pdfjs document
  let pdfLib = null;    // cached pdfjs module
  let pdfContainerEl = $state(null);

  // Re-render at new scale when user zooms (pdfDoc already loaded)
  $effect(() => {
    const scale = pdfScale;
    if (!pdfDoc) return;
    renderPages(pdfDoc, scale).catch(e => console.error('[pdf zoom]', e));
  });

  async function renderPdf(b64) {
    if (!pdfLib) {
      const [lib, { default: workerUrl }] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      pdfLib = lib;
    }
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    pdfDoc = await pdfLib.getDocument({ data }).promise;
    pdfNumPages = pdfDoc.numPages;
    await renderPages(pdfDoc, pdfScale);
  }

  async function renderPages(pdf, scale) {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

      const textDiv = document.createElement('div');
      textDiv.className = 'pdf-text-layer';

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page';
      wrapper.style.cssText = `width:${viewport.width}px;height:${viewport.height}px`;
      wrapper.appendChild(canvas);
      wrapper.appendChild(textDiv);
      pages.push(wrapper);

      // Render text layer (v4: renderTextLayer, v5: TextLayer class)
      const src = page.streamTextContent();
      if (pdfLib.renderTextLayer) {
        pdfLib.renderTextLayer({ textContentSource: src, container: textDiv, viewport });
      } else if (pdfLib.TextLayer) {
        new pdfLib.TextLayer({ textContentSource: src, container: textDiv, viewport }).render();
      }
    }
    pdfPages = pages;
  }

  // Mount page wrappers into container when pdfPages changes
  $effect(() => {
    if (!pdfContainerEl || !pdfPages) return;
    pdfContainerEl.innerHTML = '';
    for (const page of pdfPages) pdfContainerEl.appendChild(page);
  });
</script>

<div class="file-view">
  <div class="fv-header">
    <span class="fv-path" title={path}>{relativePath}</span>
    {#if isPdf && pdfPages}
      <span class="fv-pdf-pages">{pdfNumPages}p</span>
      <div class="fv-zoom">
        <button class="fv-zoom-btn" onclick={() => pdfScale = Math.max(0.5, +(pdfScale - 0.25).toFixed(2))} title="Zoom out">−</button>
        <span class="fv-zoom-label">{Math.round(pdfScale * 100)}%</span>
        <button class="fv-zoom-btn" onclick={() => pdfScale = Math.min(4, +(pdfScale + 0.25).toFixed(2))} title="Zoom in">+</button>
      </div>
    {/if}
    <button class="fv-close" onclick={onClose} title="Close file view" aria-label="Close">×</button>
  </div>

  <div class="fv-body">
    {#if loading}
      <div class="fv-status">loading…</div>
    {:else if error}
      <div class="fv-status fv-error">{error}</div>
    {:else if isImage}
      <ImagePreview src="data:{mimeType};base64,{base64}" alt={relativePath} />
    {:else if isPdf}
      {#if !pdfPages}
        <div class="fv-status">rendering pdf…</div>
      {/if}
      <div class="fv-pdf" bind:this={pdfContainerEl}></div>
    {:else if renderedHtml}
      <div class="fv-md" use:mermaidRender={renderedHtml} use:syntaxHighlight={{ theme: $effectiveSyntaxTheme }}>{@html renderedHtml}</div>
    {:else if hlHtml}
      <pre class="fv-pre fv-hl">{@html hlHtml}</pre>
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
  .fv-error { color: var(--error); }

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

  .fv-hl :global(span) { font-family: inherit; }

  .fv-zoom {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .fv-zoom-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: .85rem;
    line-height: 1;
    padding: 1px 6px;
    font-family: inherit;
  }
  .fv-zoom-btn:hover { color: var(--text); border-color: var(--text-muted); }
  .fv-zoom-label {
    font-size: .72rem;
    color: var(--text-dim);
    min-width: 3ch;
    text-align: center;
  }

  .fv-pdf-pages {
    font-size: .72rem;
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .fv-pdf {
    padding: 12px;
  }

  :global(.pdf-page) {
    position: relative;
    margin: 0 auto 8px;
  }
  :global(.pdf-page canvas) {
    display: block;
  }
  :global(.pdf-text-layer) {
    position: absolute;
    inset: 0;
    overflow: hidden;
    line-height: 1;
    user-select: text;
  }
  :global(.pdf-text-layer span),
  :global(.pdf-text-layer br) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
  }
  :global(.pdf-text-layer ::selection) {
    background: rgba(100, 150, 255, 0.35);
    color: transparent;
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
