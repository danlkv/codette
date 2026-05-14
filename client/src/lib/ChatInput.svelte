<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { tick } from 'svelte';
  let { disabled = false, placeholder = 'Message Claude…', sendLabel = 'send', onSend, header } = $props();

  let value = $state('');
  let el = $state();

  const SLASH_CMDS = [
    { cmd: '/clear',   desc: 'clear conversation' },
    { cmd: '/context', desc: 'token usage + cost' },
    { cmd: '/status',  desc: 'connection status' },
    { cmd: '/btw',     desc: 'side message (not in history)' },
    { cmd: '/reload',  desc: 'clear cache and refetch full history' },
    { cmd: '/inline-files', desc: 'instruct agent to use inline file viewer' },
  ];

  let prefix = $derived(value.split(' ')[0]);
  let matches = $derived(value.startsWith('/')
    ? SLASH_CMDS.filter(c => c.cmd.startsWith(prefix))
    : []);

  function complete(cmd) {
    value = cmd + ' ';
    el?.focus();
  }

  function send() {
    const text = value.trim();
    if (!text) return;
    const clearFn = async () => { value = ''; await tick(); resize(); };
    onSend?.(text, clearFn);
  }

  function keydown(e) {
    const isPhone = window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 768;
    if (e.key === 'Enter' && !e.shiftKey && !isPhone) { e.preventDefault(); send(); }
    if (e.key === 'Tab' && matches.length) {
      e.preventDefault();
      complete(matches[0].cmd);
    }
  }

  function resize() {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }
</script>

<div class="wrap">
  {#if matches.length}
    <div class="cmds">
      {#each matches as m}
        <button class="cmd-item" onclick={() => complete(m.cmd)}>
          <span class="cmd">{m.cmd}</span>
          <span class="desc">{m.desc}</span>
        </button>
      {/each}
    </div>
  {/if}
  {@render header?.()}
  <div class="bar">
    <textarea
      bind:this={el} bind:value
      onkeydown={keydown} oninput={resize}
      {placeholder} rows="1"
    ></textarea>
    <button onclick={send} disabled={!value.trim() || disabled}>{sendLabel}</button>
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
    position: relative;
  }
  textarea {
    flex: 1; background: var(--bg-elevated);
    border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); font: inherit; font-size: 16px;
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

  .cmds {
    max-width: 740px; margin: 0 auto 6px;
    display: flex; flex-direction: column; gap: 2px;
  }
  .cmd-item {
    display: flex; align-items: baseline; gap: 10px;
    background: none; border: none; border-radius: 4px;
    padding: 3px 6px; cursor: pointer; text-align: left;
    font: inherit; width: 100%;
    transition: background .1s;
  }
  .cmd-item:hover { background: var(--bg-elevated); }
  .cmd  { color: var(--accent-light); font-size: .8rem; min-width: 80px; }
  .desc { color: var(--text-dim); font-size: .75rem; }
</style>
