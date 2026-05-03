<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { toolIcon } from '../utils/tools.js';
  import { sessionCwd } from '../store.js';
  let { tool, running = false } = $props(); // tool: { name, summary, input, id }

  let open = $state(false);

  function rel(path) {
    if (!path || !$sessionCwd) return path;
    const prefix = $sessionCwd.endsWith('/') ? $sessionCwd : $sessionCwd + '/';
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  function editDiff(input) {
    if (!input?.old_string && !input?.new_string) return null;
    const oldLines = (input.old_string ?? '').split('\n');
    const newLines = (input.new_string ?? '').split('\n');
    return { oldLines, newLines };
  }
</script>

<div class="tool" class:open>
  <button class="header" onclick={() => open = !open} title="Click to {open ? 'collapse' : 'expand'}">
    <span class="icon">{toolIcon(tool.name)}</span>
    <span class="name">{tool.name}</span>
    {#if tool.summary}
      <span class="sep">›</span>
      <span class="arg">{rel(tool.summary)}</span>
    {/if}
    <span class="spacer"></span>
    {#if running}
      <span class="badge running">running</span>
    {:else}
      <span class="badge done">done</span>
    {/if}
    <span class="chevron">{open ? '▾' : '▸'}</span>
  </button>
  {#if open}
    <div class="detail">
      {#if tool.input}
        {#if tool.name === 'Edit' && editDiff(tool.input)}
          {@const diff = editDiff(tool.input)}
          {#if tool.input.file_path}
            <div class="diff-path">{rel(tool.input.file_path)}</div>
          {/if}
          <div class="diff">
            {#each diff.oldLines as line}
              <div class="diff-line del"><span class="diff-sig">-</span><span class="diff-text">{line}</span></div>
            {/each}
            {#each diff.newLines as line}
              <div class="diff-line add"><span class="diff-sig">+</span><span class="diff-text">{line}</span></div>
            {/each}
          </div>
        {:else if tool.name === 'Write' && tool.input?.content != null}
          {#if tool.input.file_path}
            <div class="diff-path">{rel(tool.input.file_path)}</div>
          {/if}
          <div class="diff">
            {#each tool.input.content.split('\n') as line}
              <div class="diff-line add"><span class="diff-sig">+</span><span class="diff-text">{line}</span></div>
            {/each}
          </div>
        {:else}
          <pre>{JSON.stringify(tool.input, null, 2)}</pre>
        {/if}
      {/if}
      {#if tool.result != null}
        <div class="result-header">
          <span class="result-label">result</span>
          <span class="result-count">{tool.result.total} chars{tool.result.capped ? ' (capped at 2000)' : ''}</span>
        </div>
        <pre class="result">{tool.result.text}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool {
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    margin-top: 6px;
    background: var(--bg-secondary);
  }
  .header {
    display: flex; align-items: center; gap: 6px;
    width: 100%; padding: 6px 10px;
    background: none; border: none; cursor: pointer;
    color: var(--text-muted); text-align: left;
    font: inherit; font-size: .8rem;
  }
  .header:hover { background: var(--bg-elevated); }
  .icon  { font-size: .9rem; }
  .name  { color: var(--accent-light); font-weight: 500; }
  .sep   { color: var(--text-dim); }
  .arg   { color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40ch; }
  .spacer { flex: 1; }
  .badge {
    font-size: .7rem; padding: 1px 6px; border-radius: 99px;
  }
  .badge.running { background: #78350f; color: #fcd34d; }
  .badge.done    { background: #14532d; color: #86efac; }
  @media (prefers-color-scheme: light) {
    .badge.running { background: #fef3c7; color: #92400e; }
    .badge.done    { background: #dcfce7; color: #065f46; }
  }
  .chevron { color: var(--text-dim); font-size: .7rem; }
  .detail {
    border-top: 1px solid var(--border);
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .detail pre {
    margin: 0; font: .78rem/1.5 'SF Mono', 'Fira Code', monospace;
    color: var(--text-muted); white-space: pre-wrap; word-break: break-all;
  }
  .result-header {
    display: flex; align-items: center; gap: 8px;
    border-top: 1px solid var(--border);
    padding-top: 6px;
    margin-top: 2px;
  }
  .result-label {
    font-size: .68rem; font-weight: 600; letter-spacing: .05em;
    text-transform: uppercase; color: var(--text-dim);
  }
  .result-count {
    font-size: .68rem; color: var(--text-dim);
  }
  pre.result {
    margin: 0; font: .78rem/1.5 'SF Mono', 'Fira Code', monospace;
    color: var(--text-muted); white-space: pre-wrap; word-break: break-all;
    background: var(--pre-bg); border-radius: 4px; padding: 6px 8px;
  }
  .diff-path {
    font: .75rem/1.4 'SF Mono', 'Fira Code', monospace;
    color: var(--text-dim); margin-bottom: 6px;
  }
  .diff {
    font: .78rem/1.5 'SF Mono', 'Fira Code', monospace;
    border-radius: 4px; overflow: hidden;
  }
  .diff-line {
    display: flex; gap: 6px;
    padding: 0 6px; white-space: pre-wrap; word-break: break-all;
  }
  .diff-line.del { background: #2d0a0a; color: #fca5a5; }
  .diff-line.add { background: #0a2d14; color: #86efac; }
  .diff-sig { user-select: none; opacity: 0.6; min-width: 1ch; }
  .diff-text { flex: 1; }
  @media (prefers-color-scheme: light) {
    .diff-line.del { background: #fde8e8; color: #9b1c1c; }
    .diff-line.add { background: #dcfce7; color: #14532d; }
  }
</style>
