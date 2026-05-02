<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { afterUpdate } from 'svelte';
  import { messages } from '../store.js';
  import MessageBubble from './MessageBubble.svelte';
  export let hostStatus;

  let el;
  let pinned = true;

  afterUpdate(() => {
    if (pinned && el) el.scrollTop = el.scrollHeight;
  });

  function onScroll() {
    if (!el) return;
    pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }
</script>

<div class="list" bind:this={el} on:scroll={onScroll}>
  <div class="inner">
    {#if $messages.length === 0}
      <div class="empty">
        {#if hostStatus !== 'connected'}
          <p>Waiting for host…</p>
          <code>SERVER_URL=wss://chat.example.com HOST_KEY=… node host/index.js</code>
        {:else}
          <p>Say something</p>
        {/if}
      </div>
    {/if}

    {#each $messages as m (m.id)}
      <MessageBubble msg={m} isStreaming={!!m.streaming} />
    {/each}
  </div>
</div>

<style>
  .list {
    flex: 1; overflow-y: auto; scroll-behavior: smooth;
  }
  .inner {
    display: flex; flex-direction: column; gap: 20px;
    align-items: stretch;
    max-width: 760px; margin: 0 auto;
    padding: 24px 16px 16px;
  }
  /* collapse gap between consecutive tool rows */
  .inner :global(.tool-row + .tool-row) { margin-top: -14px; }
  .empty {
    display: flex; flex-direction: column; align-items: center;
    gap: 10px; margin-top: 80px; color: var(--text-dim);
    font-size: .9rem; text-align: center;
  }
  .empty code {
    color: var(--text-muted); background: var(--bg-elevated);
    padding: 4px 10px; border-radius: 6px; font-size: .8rem;
  }
</style>
