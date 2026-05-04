<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { messages } from '../store.js';
  import MessageBubble from './MessageBubble.svelte';
  import { tweened } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  let { hostStatus } = $props();

  let el = $state();
  let pinned = $state(true);

  $effect(() => {
    void $messages;
    if (pinned && el) el.scrollTop = el.scrollHeight;
  });

  function onScroll() {
    if (!el) return;
    pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function scrollToBottom() {
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned = true;
  }

  function getUserMsgEls() {
    return [...el.querySelectorAll('.row.user')];
  }

  const scrollAnim = tweened(0, { duration: 70, easing: cubicOut });
  let animating = false;
  $effect(() => {
    return scrollAnim.subscribe(v => { if (animating && el) el.scrollTop = v; });
  });
  function animateScroll(target) {
    animating = true;
    scrollAnim.set(el.scrollTop, { duration: 0 });
    scrollAnim.set(target).then(() => { animating = false; });
  }

  function scrollToPrevUser() {
    if (!el) return;
    const containerTop = el.getBoundingClientRect().top;
    const els = getUserMsgEls();
    for (let i = els.length - 1; i >= 0; i--) {
      const msgTop = els[i].getBoundingClientRect().top - containerTop;
      if (msgTop < -20) {
        animateScroll(el.scrollTop + msgTop - 8);
        return;
      }
    }
  }

  function scrollToNextUser() {
    if (!el) return;
    const containerTop = el.getBoundingClientRect().top;
    const els = getUserMsgEls();
    for (let i = 0; i < els.length; i++) {
      const msgTop = els[i].getBoundingClientRect().top - containerTop;
      if (msgTop > 20) {
        animateScroll(el.scrollTop + msgTop - 8);
        return;
      }
    }
  }
</script>

<div class="wrap">
  <div class="list" bind:this={el} onscroll={onScroll}>
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

  <div class="nav-btns" class:pinned>
    <button class="nav-btn" onclick={scrollToPrevUser} title="Previous user message">↑</button>
    <button class="nav-btn" onclick={scrollToNextUser} title="Next user message">↓</button>
  </div>

  {#if !pinned}
    <button class="scroll-btn" onclick={scrollToBottom} title="Scroll to bottom">↓</button>
  {/if}
</div>

<style>
  .wrap {
    flex: 1; overflow: hidden; position: relative; display: flex; flex-direction: column;
  }
  .list {
    flex: 1; overflow-y: auto;
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

  .nav-btns {
    position: absolute;
    bottom: 56px;
    left: calc(50% + 760px / 2 + 12px);
    display: flex; flex-direction: column;
    width: 32px;
  }
  .nav-btn {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-muted);
    width: 32px; height: 32px;
    font-size: 1rem; line-height: 1;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: color .15s, border-color .15s;
  }
  .nav-btn:first-child { border-radius: 4px 4px 0 0; }
  .nav-btn:last-child  { border-radius: 0 0 4px 4px; border-top: none; }
  .nav-btn:hover { color: var(--text); border-color: var(--text-muted); }

  .scroll-btn {
    position: absolute;
    bottom: 16px;
    left: calc(50% + 760px / 2 + 12px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: 50%;
    width: 32px; height: 32px;
    font-size: 1rem; line-height: 1;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: color .15s, border-color .15s;
  }
  .scroll-btn:hover { color: var(--text); border-color: var(--text-muted); }

  @media (max-width: calc(760px + 80px + 300px)) {
    .nav-btns, .scroll-btn { left: auto; right: 16px; }
  }
  @media (max-width: 1130px) {
    .nav-btns.pinned { display: none; }
  }
</style>
