<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script module>
  // In-flight deduplication: path → Promise<string>. Entries deleted on resolve.
  const inflight = new Map();
</script>

<script>
  import { onMount } from 'svelte';
  import { effectiveSyntaxTheme } from '../store.js';
  import { fetchFile } from '../utils/api.js';
  import { highlightLines, langFromPath } from '../utils/highlight.js';

  let { path, ranges = [], annotations = [], sessionId, token, onOpenFile = null, messageTime = null } = $props();

  const MAX_LINES = 600;

  let lines = $state(null);
  let hlLines = $state(null); // per-line highlighted HTML, or null if no theme
  let hlBg    = $state(null); // theme background color
  let hlFg    = $state(null); // theme foreground color (for plain text)
  let error = $state(null);
  let containerEl = $state(null);
  let preEl = $state(null);
  let displayStart = $state(1);
  let truncated = $state(false);
  let totalLines = $state(0);
  let hlIdx = $state(0);
  let collapsed = $state(false);
  let showAnnotations = $state(true);
  let stale = $state(false);

  // Set of all highlighted line numbers (all lines within any range)
  const hlSet = $derived((() => {
    const s = new Set();
    for (const r of ranges) for (let i = r.start; i <= r.end; i++) s.add(i);
    return s;
  })());

  // Annotation map: line → text
  const annMap = $derived(new Map(annotations.map(a => [a.line, a.text])));

  // Navigation targets: first line of each range, in agent-specified order
  const navTargets = $derived(ranges.map(r => r.start));

  // Header label: path + ranges spec
  const rangeLabel = $derived(
    ranges.length
      ? ':' + ranges.map(r => r.start === r.end ? r.start : `${r.start}-${r.end}`).join(',')
      : ''
  );

  async function fetchContent() {
    if (!sessionId || !token) throw new Error('no session');
    const data = await fetchFile(sessionId, path, token);
    if (data.error) throw new Error(data.error);
    return data;
  }

  let rawContent = $state(null); // full file text, kept for re-highlighting

  function applyContent(content, mtime) {
    if (annotations.length && messageTime != null && mtime != null && mtime > messageTime) stale = true;
    rawContent = content ?? '';
    const all = rawContent.split('\n');
    totalLines = all.length;
    // View window: cover all ranges + context padding up to MAX_LINES
    const minLine = ranges.length ? Math.min(...ranges.map(r => r.start)) : 1;
    const maxLine = ranges.length ? Math.max(...ranges.map(r => r.end)) : all.length;
    const rs = minLine - 1;
    const re = maxLine;
    const extra = Math.max(0, MAX_LINES - (re - rs));
    const above = Math.min(rs, Math.floor(extra / 2));
    const below = Math.min(all.length - re, extra - above);
    const s = rs - above;
    const e = re + below;
    displayStart = s + 1;
    lines = all.slice(s, e);
    truncated = s > 0 || e < all.length;
    requestAnimationFrame(scrollToTarget);
  }

  function loadFile() {
    const p = inflight.get(path) ?? (() => {
      const req = fetchContent().finally(() => inflight.delete(path));
      inflight.set(path, req);
      return req;
    })();
    p.then(({ content, mtime }) => {
      applyContent(content, mtime);
    }).catch(err => { error = err.message; });
  }

  // Re-highlight whenever theme or loaded lines change
  $effect(() => {
    const theme = $effectiveSyntaxTheme;
    const content = rawContent;
    if (!theme || content === null || lines === null) { hlLines = null; hlBg = null; hlFg = null; return; }
    const lang = langFromPath(path);
    const sliced = lines.join('\n');
    highlightLines(sliced, lang, theme).then(({ lines: hl, bg, fg }) => { hlLines = hl; hlBg = bg; hlFg = fg; }).catch(() => { hlLines = null; hlBg = null; hlFg = null; });
  });

  function scrollToLine(lineNum) {
    if (!preEl || !lines) return;
    const offset = lineNum - displayStart;
    const lineEls = preEl.querySelectorAll('.sf-line');
    const el = lineEls[offset];
    if (!el) return;
    const scrollEl = preEl.parentElement;
    const lineHeight = el.offsetHeight || 20;
    const elRect = el.getBoundingClientRect();
    const containerRect = scrollEl.getBoundingClientRect();
    scrollEl.scrollTop += elRect.top - containerRect.top - lineHeight * 3;
  }

  function scrollToTarget() {
    const target = navTargets[0] ?? null;
    if (target) scrollToLine(target);
  }

  function jumpPrevHl() {
    if (!navTargets.length) return;
    hlIdx = (hlIdx - 1 + navTargets.length) % navTargets.length;
    scrollToLine(navTargets[hlIdx]);
  }

  function jumpNextHl() {
    if (!navTargets.length) return;
    hlIdx = (hlIdx + 1) % navTargets.length;
    scrollToLine(navTargets[hlIdx]);
  }

  onMount(() => {
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        loadFile();
      }
    }, { threshold: 0.1 });
    observer.observe(containerEl);
    return () => observer.disconnect();
  });

  function copyPath() {
    navigator.clipboard.writeText(path).catch(() => {});
  }

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
</script>

<div class="sf-block" bind:this={containerEl}>
  <div class="sf-header">
    <span class="sf-path" title={path}>
      {path}{rangeLabel}
    </span>
    {#if navTargets.length > 1}
      <div class="sf-hl-nav">
        <button class="sf-nav" onclick={jumpPrevHl} title="Previous range">↑</button>
        <span class="sf-hl-pos">{hlIdx + 1}/{navTargets.length}</span>
        <button class="sf-nav" onclick={jumpNextHl} title="Next range">↓</button>
      </div>
    {/if}
    {#if onOpenFile}
      <button class="sf-view" onclick={() => onOpenFile(path)} title="View full file">view file</button>
    {/if}
    {#if stale}
      <span class="sf-stale" title="File was modified after this message — annotations may be misaligned">⚠ file modified</span>
    {/if}
    {#if annotations.length}
      <button class="sf-ann-toggle" onclick={() => showAnnotations = !showAnnotations} title={showAnnotations ? 'Hide annotations' : 'Show annotations'}>{showAnnotations ? 'hide notes' : 'show notes'}</button>
    {/if}
    <button class="sf-copy" onclick={copyPath} title="Copy path">copy path</button>
    <button class="sf-toggle" onclick={() => collapsed = !collapsed} title={collapsed ? 'Expand' : 'Collapse'}>{collapsed ? '▶' : '▼'}</button>
  </div>
  {#if !collapsed}
  <div class="sf-body" class:sf-body-loading={lines === null && !error}>
    {#if error}
      <pre class="sf-pre sf-error">[could not load: {error}]</pre>
    {:else if lines === null}
      <pre class="sf-pre sf-loading">loading…</pre>
    {:else}
      <pre class="sf-pre" bind:this={preEl} style:background={hlBg} style:color={hlFg}>{#each lines as line, i}{@const lineNum = displayStart + i}<span
          class="sf-line"
          class:sf-hl={hlSet.has(lineNum)}
        ><span class="sf-ln">{lineNum}</span><span class="sf-code">{@html hlLines ? hlLines[i] : esc(line)}</span>{#if showAnnotations && annMap.has(lineNum)}<span class="sf-ann">{annMap.get(lineNum)}</span>{/if}</span>{/each}</pre>
      {#if truncated}
        <div class="sf-trunc">lines {displayStart}–{displayStart + lines.length - 1} of {totalLines}</div>
      {/if}
    {/if}
  </div>
  {/if}
</div>

<style>
  .sf-block {
    border: 1px solid var(--border);
    border-radius: 5px;
    margin: .5em 0;
    overflow: hidden;
    font-family: monospace;
    font-size: .85em;
  }
  .sf-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    padding: 4px 10px;
    gap: 8px;
  }
  .sf-path {
    color: var(--text-muted);
    font-size: .8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .sf-hl-nav {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .sf-hl-pos {
    font-size: .68em;
    color: var(--text-dim);
    min-width: 2.5em;
    text-align: center;
  }
  .sf-nav {
    background: none;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
    cursor: pointer;
    font: inherit;
    font-size: .8em;
    padding: 2px 7px;
    flex-shrink: 0;
    line-height: 1.4;
    transition: color .15s, border-color .15s;
  }
  .sf-nav:hover { color: var(--accent-light); border-color: var(--accent); }
  .sf-stale {
    font-size: .75em;
    color: rgba(220, 170, 50, 0.75);
    flex-shrink: 0;
    user-select: none;
  }
  .sf-ann-toggle, .sf-view, .sf-copy {
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
  .sf-ann-toggle:hover, .sf-view:hover, .sf-copy:hover { color: var(--accent-light); border-color: var(--accent); }
  .sf-toggle {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font: inherit;
    font-size: .8em;
    padding: 3px 5px;
    flex-shrink: 0;
    transition: color .15s;
  }
  .sf-toggle:hover { color: var(--text); }
  .sf-body {
    overflow: auto;
    max-height: 30vh;
    background: var(--bg-primary);
  }
  .sf-body-loading {
    min-height: 30vh;
  }
  .sf-body::-webkit-scrollbar-corner { background: var(--bg-primary); }
  .sf-pre {
    margin: 0;
    padding: 6px 0;
    color: var(--text);
    display: block;
    min-width: max-content;
  }
  .sf-pre.sf-loading, .sf-pre.sf-error {
    padding: 6px 12px;
    color: var(--text-dim);
    font-style: italic;
  }
  .sf-line {
    display: flex;
    width: max-content;
    min-width: 100%;
    min-height: 1.4em;
  }
  .sf-line.sf-hl {
    background: rgba(97, 175, 239, 0.12);
  }
  .sf-ann {
    position: sticky;
    right: 0;
    margin-left: 4em;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    align-self: stretch;
    padding: 0 10px;
    background: var(--bg-elevated);
    border-left: 2px solid rgba(220, 190, 80, 0.35);
    color: rgba(220, 190, 80, 0.85);
    font-style: italic;
    font-size: .9em;
    user-select: none;
    white-space: nowrap;
    box-shadow: -3px 0px 8px 2px var(--bg-elevated);
  }
  :global([data-theme="light"]) .sf-ann {
    border-left-color: rgba(140, 100, 0, 0.45);
    color: rgba(130, 90, 0, 0.9);
  }
  .sf-ln {
    display: inline-block;
    min-width: 3.5em;
    padding: 0 10px 0 6px;
    color: var(--text-dim);
    user-select: none;
    text-align: right;
    flex-shrink: 0;
  }
  .sf-code {
    white-space: pre;
  }
  .sf-trunc {
    padding: 3px 10px;
    font-size: .75em;
    color: var(--text-dim);
    background: var(--bg-elevated);
    border-top: 1px solid var(--border);
    text-align: center;
  }
</style>
