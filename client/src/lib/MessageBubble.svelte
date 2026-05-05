<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { renderMd } from '../utils/markdown.js';
  import { mermaidRender } from '../utils/mermaid-action.js';
  import { sourceFileRender } from '../utils/sourcefile-action.js';
  import { fmtTime } from '../utils/time.js';
  import ToolBlock from './ToolBlock.svelte';
  import QuestionBlock from './QuestionBlock.svelte';
  import TodoBlock from './TodoBlock.svelte';
  let { msg, isStreaming = false, sessionId = null, token = null, onOpenFile = null } = $props();
</script>

{#if msg.role === 'system'}
  <p class="sys">{msg.text}</p>

{:else if msg.role === 'tool'}
  <div class="tool-row">
    <span class="label">⚙</span>
    <ToolBlock tool={msg} running={msg.running} />
  </div>

{:else if msg.role === 'user_question'}
  <QuestionBlock {msg} />

{:else if msg.role === 'todo'}
  <TodoBlock {msg} />

{:else}
  <div class="row {msg.role}">
    <span class="label">{msg.role === 'user' ? 'you' : 'claude'}{#if msg.ts}<span class="msg-time">{fmtTime(msg.ts)}</span>{/if}</span>
    <div class="body">
      {#if msg.role === 'user'}
        <p class="user-text">{msg.text}</p>
      {:else}
        <div class="prose" use:mermaidRender={msg.text} use:sourceFileRender={{ text: msg.text, sessionId, token, onOpenFile, messageTime: msg.ts ?? null }}>
          {@html renderMd(msg.text)}{#if isStreaming}<span class="cur">▌</span>{/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sys {
    text-align: center; color: var(--text-dim);
    font-size: .78rem; font-style: italic; margin: 2px 0;
  }

  .tool-row {
    display: flex; gap: 8px; align-items: flex-start;
  }
  .tool-row .label {
    /* compact UI style */ font-size: .65rem; flex-shrink: 0;
    /* compact UI style */ padding-top: 4px; text-align: right; color: var(--text-dim);
  }
  .tool-row :global(.tool) { flex: 1; margin-top: 0; }

  .row { display: flex; flex-direction: column; gap: 3px; }
  .row.user { padding-top: 16px; }
  .label { font-size: .72rem; color: var(--text-dim); display: flex; align-items: baseline; gap: 5px; }
  .row.user .label      { color: var(--user-color); }
  .row.assistant .label { color: var(--accent-light); }
  .msg-time { font-size: .6rem; color: var(--text-muted); font-weight: 400; }

  .user-text {
    color: var(--text); background: var(--bg-elevated); line-height: 1.5;
    white-space: pre-wrap; word-break: break-word; margin: 0;
    border: 1px solid var(--accent);
    border-radius: 4px; padding: 7px 10px;
    font-family: var(--chat-font);
  }

  .prose { color: var(--text); line-height: 1.35; /* compact UI style */ font-family: var(--chat-font); }
  .prose :global(p)            { margin: 0 0 .6em; }
  .prose :global(p:last-child) { margin-bottom: 0; }
  .prose :global(h1),.prose :global(h2),.prose :global(h3),
  .prose :global(h4),.prose :global(h5),.prose :global(h6) {
    font-weight: 600; color: var(--text); margin: 1em 0 .3em; line-height: 1.3;
  }
  .prose :global(h1) { font-size: 1.1em; }
  .prose :global(h2) { font-size: 1.0em; }
  .prose :global(h3) { font-size: .95em; }
  .prose :global(code) {
    background: var(--bg-elevated);
    border-radius: 3px; padding: 1px 5px;
    font-size: .88em; color: var(--accent-light); font-family: monospace;
  }
  .prose :global(pre:not(.sf-pre)) {
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 5px; padding: 10px 14px; overflow-x: auto; margin: .5em 0;
    font-family: monospace;
  }
  .prose :global(pre code) { background: none; border: none; padding: 0; color: var(--text); font-size: .88em; }
  .prose :global(ul),.prose :global(ol) { padding-left: 1.5em; margin: .4em 0; }
  .prose :global(li)    { margin: .2em 0; }
  .prose :global(blockquote) {
    border-left: 3px solid var(--border); margin: .5em 0;
    padding: .1em 0 .1em .9em; color: var(--text-muted);
  }
  .prose :global(a)     { color: var(--accent-light); text-decoration: none; }
  .prose :global(a:hover) { text-decoration: underline; }
  .prose :global(strong){ color: var(--text); font-weight: 600; }
  .prose :global(em)    { color: var(--text-muted); }
  .prose :global(hr)    { border: none; border-top: 1px solid var(--border); margin: .8em 0; }
  .prose :global(table) { border-collapse: collapse; width: 100%; margin: .5em 0; font-size: .88em; }
  .prose :global(th),.prose :global(td) { border: 1px solid var(--border); padding: 4px 10px; }
  .prose :global(th)    { background: var(--bg-elevated); color: var(--text-muted); }
  .prose :global(.math-block) { margin: .5em 0; }
  .prose :global(.katex-display) { margin: 0; overflow: auto hidden; padding-bottom: .15em; }
  .cur { color: var(--accent); animation: blink .7s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
</style>
