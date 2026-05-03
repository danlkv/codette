<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { onMount } from 'svelte';
  import Login        from './lib/Login.svelte';
  import ChatLayout   from './lib/ChatLayout.svelte';
  import { highContrast } from './store.js';

  let token = $state(localStorage.getItem('chat_token') || '');

  function handleLogin(t)  { token = t; localStorage.setItem('chat_token', token); }
  function handleLogout()  { token = ''; localStorage.removeItem('chat_token'); }

  // Persist high-contrast preference and apply class to <html>
  $effect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('high-contrast', $highContrast);
      localStorage.setItem('hc', $highContrast ? '1' : '0');
    }
  });

  // Fix mobile keyboard shrinking the viewport
  onMount(() => {
    function setVh() {
      const h = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-height', h + 'px');
    }
    setVh();
    window.visualViewport?.addEventListener('resize', setVh);
    window.addEventListener('resize', setVh);
    return () => {
      window.visualViewport?.removeEventListener('resize', setVh);
      window.removeEventListener('resize', setVh);
    };
  });
</script>

{#if token}
  <ChatLayout {token} onLogout={handleLogout} />
{:else}
  <Login onLogin={handleLogin} />
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(:root) {
    --bg-primary:   #0d0d0d;
    --bg-secondary: #111111;
    --bg-elevated:  #1c1c1c;
    --border:       #2a2a2a;
    --text:         #e0e0e0;
    --text-muted:   #888;
    --text-dim:     #444;
    --accent:       #cc5500;
    --accent-light: #e06020;
    --user-color:   #9090c8;
    --user-label:   #88a;
    --user-text:    #b8b8e8;
    --status-ok:    #4f4;
    --code-bg:      #1e1e2e;
    --code-color:   #e8c97a;
    --pre-bg:       #161620;
    --pre-code:     #cdd6f4;
    --link:         #7ab4f5;
    --tool-name:    #b8862a;
    --btn-bg:       #2a2a6a;
    --btn-hover:    #3a3a8a;
    --cursor:       #7af;
  }
  @media (prefers-color-scheme: light) {
    :global(:root) {
      --bg-primary:   #f5f5f5;
      --bg-secondary: #ffffff;
      --bg-elevated:  #e8e8e8;
      --border:       #d0d0d0;
      --text:         #1a1a1a;
      --text-muted:   #666;
      --text-dim:     #aaa;
      --user-color:   #5050a8;
      --user-label:   #668;
      --user-text:    #3030a0;
      --status-ok:    #0a0;
      --code-bg:      #eef0f8;
      --code-color:   #8b6914;
      --pre-bg:       #f4f4fc;
      --pre-code:     #2a2a5a;
      --link:         #1a6bc4;
      --tool-name:    #8b5a10;
      --btn-bg:       #d0d8f0;
      --btn-hover:    #b8c4e8;
      --cursor:       #36c;
    }
  }
  :global(.high-contrast) {
    --border:       #888888;
    --text:         #ffffff;
    --text-muted:   #cccccc;
    --text-dim:     #999999;
    --accent:       #ff8c00;
    --accent-light: #ffaa00;
    --user-color:   #9090ff;
    --user-label:   #bbbbff;
    --user-text:    #d0d0ff;
    --status-ok:    #44ff44;
    --code-color:   #ffe066;
    --pre-code:     #e8eeff;
    --link:         #66ccff;
    --tool-name:    #ffcc44;
    --cursor:       #66ccff;
  }
  @media (prefers-color-scheme: light) {
    :global(.high-contrast) {
      --border:       #555555;
      --text:         #000000;
      --text-muted:   #333333;
      --text-dim:     #666666;
      --accent:       #b84400;
      --accent-light: #cc5500;
      --user-color:   #2020aa;
      --user-label:   #334499;
      --user-text:    #1010aa;
      --status-ok:    #006600;
      --code-color:   #7a5000;
      --pre-code:     #11115a;
      --link:         #0044cc;
      --tool-name:    #7a4400;
      --cursor:       #0044cc;
    }
  }
  :global(body) {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 14px;
    background: var(--bg-primary);
    color: var(--text);
    height: var(--app-height, 100dvh);
    overflow: hidden;
  }
  :global(#app) { height: var(--app-height, 100dvh); display: flex; flex-direction: column; }
  :global(::-webkit-scrollbar) { width: 6px; }
  :global(::-webkit-scrollbar-track) { background: transparent; }
  :global(::-webkit-scrollbar-thumb) { background: var(--bg-elevated); border-radius: 3px; }

  :global(.mermaid-wrap) { position: relative; display: inline-block; max-width: 100%; }
  :global(.mermaid-toggle) {
    position: absolute; top: 4px; right: 4px;
    background: var(--bg-elevated); border: 1px solid var(--border);
    color: var(--text-dim); font-size: .65rem; font-family: inherit;
    padding: 1px 6px; border-radius: 3px; cursor: pointer; opacity: 0;
    transition: opacity .15s;
  }
  :global(.mermaid-wrap:hover .mermaid-toggle) { opacity: 1; }
  :global(.mermaid-toggle:hover) { color: var(--text); border-color: var(--text-muted); }
  :global(.mermaid-source) {
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 4px; padding: 10px 14px; font-size: .78rem;
    color: var(--text-muted); white-space: pre; overflow-x: auto;
    margin: .4em 0; font-family: monospace;
  }
</style>
