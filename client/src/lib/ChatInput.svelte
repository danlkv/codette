<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();
  export let disabled = false;
  export let placeholder = 'Message Claude…';

  let value = '';
  let el;

  const SLASH_CMDS = [
    { cmd: '/clear',  desc: 'clear display' },
    { cmd: '/status', desc: 'connection status' },
    { cmd: '/usage',  desc: 'session cost' },
    { cmd: '/btw',    desc: 'side question (not in history)' },
  ];
  $: hint = value.startsWith('/')
    ? SLASH_CMDS.find(c => c.cmd.startsWith(value.split(' ')[0]))
    : null;

  function send() {
    const text = value.trim();
    if (!text) return;
    value = '';
    resize();
    dispatch('send', text);
  }

  function keydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function resize() {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }
</script>

<div class="wrap">
  {#if hint}
    <div class="hint"><span class="cmd">{hint.cmd}</span> — {hint.desc}</div>
  {/if}
  <div class="bar">
    <textarea
      bind:this={el} bind:value
      on:keydown={keydown} on:input={resize}
      {placeholder} {disabled} rows="1"
    ></textarea>
    <button on:click={send} disabled={!value.trim() || disabled}>send</button>
  </div>
</div>

<style>
  .wrap {
    border-top: 1px solid var(--border);
    background: var(--bg-secondary);
    padding: 10px 16px 12px;
    flex-shrink: 0;
  }
  .bar {
    display: flex; align-items: flex-end; gap: 8px;
    max-width: 740px; margin: 0 auto;
  }
  textarea {
    flex: 1; background: var(--bg-elevated);
    border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); font: inherit; font-size: .9rem;
    padding: 7px 10px; line-height: 1.5;
    resize: none; min-height: 36px; max-height: 200px; overflow-y: auto;
    transition: border-color .15s;
  }
  textarea:focus { outline: none; border-color: var(--accent); }
  textarea::placeholder { color: var(--text-dim); }
  textarea:disabled { opacity: .4; cursor: default; }
  button {
    background: none; border: 1px solid var(--border);
    color: var(--accent); font: inherit; font-size: .8rem;
    padding: 7px 12px; border-radius: 6px; cursor: pointer;
    white-space: nowrap; transition: border-color .15s, color .15s;
    align-self: flex-end;
  }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-light); }
  button:disabled { opacity: .25; cursor: default; }
  .hint {
    max-width: 740px; margin: 0 auto 6px;
    font-size: .75rem; color: var(--text-muted);
  }
  .cmd { color: var(--accent-light); }
</style>
