<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import Login        from './lib/Login.svelte';
  import ChatLayout   from './lib/ChatLayout.svelte';
  import { colorScheme, highContrast, fontStyle, syntaxTheme, effectiveSyntaxTheme, accentColor, resetStores } from './store.js';
  import { THEME_PAIRS } from './utils/highlight.js';
  import { getAccounts, saveAccounts, saveSettings } from './utils/storage.js';

  function lightenHex(hex, amount = 0.08) {
    const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h = 0, s = 0, l = (max+min)/2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d/(2-max-min) : d/(max+min);
      if      (max===r) h = ((g-b)/d + (g<b?6:0))/6;
      else if (max===g) h = ((b-r)/d + 2)/6;
      else              h = ((r-g)/d + 4)/6;
    }
    l = Math.min(1, l + amount);
    const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
    const hue = t => { t=(t%1+1)%1; return t<1/6?p+(q-p)*6*t:t<1/2?q:t<2/3?p+(q-p)*(2/3-t)*6:p; };
    const h2 = x => Math.round(x*255).toString(16).padStart(2,'0');
    return `#${h2(hue(h+1/3))}${h2(hue(h))}${h2(hue(h-1/3))}`;
  }

  function initAccounts() {
    const { accounts: accs, active } = getAccounts();
    // resolve active username to index
    const h = location.hash.slice(1);
    const slash = h.indexOf('/');
    const urlUser = slash >= 0 ? h.slice(0, slash) : null;
    if (urlUser) {
      const idx = accs.findIndex(a => a.username === urlUser);
      return { accs, idx: idx >= 0 ? idx : accs.length };
    }
    if (active) {
      const idx = accs.findIndex(a => a.username === active);
      if (idx >= 0) return { accs, idx };
    }
    return { accs, idx: Math.min(0, Math.max(accs.length - 1, 0)) };
  }

  const { accs: _initAccs, idx: _initIdx } = initAccounts();
  let accounts = $state(_initAccs);
  let activeIdx = $state(_initIdx);
  let addingAccount = $state(false);

  const token = $derived(accounts[activeIdx]?.token || '');

  function persist() {
    saveAccounts(accounts, accounts[activeIdx]?.username ?? null);
  }

  function handleLogin(t) {
    try {
      const { username } = JSON.parse(atob(t.split('.')[1]));
      const i = accounts.findIndex(a => a.username === username);
      if (i >= 0) { accounts[i] = { ...accounts[i], token: t }; activeIdx = i; }
      else { accounts = [...accounts, { username, token: t, settings: {} }]; activeIdx = accounts.length - 1; }
    } catch {
      accounts = [...accounts, { username: '?', token: t, settings: {} }];
      activeIdx = accounts.length - 1;
    }
    addingAccount = false;
    persist();
  }

  function handleLogout() {
    accounts = accounts.filter((_, i) => i !== activeIdx);
    activeIdx = Math.min(activeIdx, Math.max(accounts.length - 1, 0));
    persist();
  }

  function handleSwitch(idx) { resetStores(); activeIdx = idx; persist(); }

  // Apply per-account settings when active account changes
  $effect(() => {
    const s = accounts[activeIdx]?.settings ?? {};
    syntaxTheme.set(s.syntaxTheme ?? null);
    accentColor.set(s.accentColor ?? null);
  });

  // Persist syntaxTheme to active account
  $effect(() => {
    const theme = $syntaxTheme;
    const acc = accounts[activeIdx];
    if (!acc || (acc.settings?.syntaxTheme ?? null) === theme) return;
    accounts[activeIdx] = { ...acc, settings: { ...(acc.settings ?? {}), syntaxTheme: theme } };
    persist();
  });

  // Persist accentColor to active account + apply CSS vars
  $effect(() => {
    const color = $accentColor;
    const acc = accounts[activeIdx];
    if (acc && (acc.settings?.accentColor ?? null) !== color) {
      accounts[activeIdx] = { ...acc, settings: { ...(acc.settings ?? {}), accentColor: color } };
      persist();
    }
    const root = document.documentElement;
    if (color) {
      root.style.setProperty('--accent', color);
      root.style.setProperty('--accent-light', lightenHex(color));
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-light');
    }
  });

  // Apply color scheme + resolve effective syntax theme
  // JS always sets data-theme so CSS never needs @media
  const _mq = window.matchMedia('(prefers-color-scheme: light)');
  $effect(() => {
    const scheme = $colorScheme;
    const themeKey = $syntaxTheme;
    const apply = () => {
      const effective = scheme === 'system' ? (_mq.matches ? 'light' : 'dark') : scheme;
      document.documentElement.setAttribute('data-theme', effective);
      const pair = THEME_PAIRS[themeKey];
      effectiveSyntaxTheme.set(pair ? pair[effective] : themeKey);
    };
    apply();
    saveSettings('colorScheme', scheme);
    if (scheme === 'system') {
      _mq.addEventListener('change', apply);
      return () => _mq.removeEventListener('change', apply);
    }
  });

  // Persist high-contrast preference and apply class to <html>
  $effect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('high-contrast', $highContrast);
      saveSettings('highContrast', $highContrast);
    }
  });

  const FONT_FAMILIES = {
    mono:  "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    sans:  "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
  };

  $effect(() => {
    document.documentElement.style.setProperty('--chat-font', FONT_FAMILIES[$fontStyle] ?? FONT_FAMILIES.mono);
    saveSettings('font', $fontStyle);
  });

</script>

{#if token}
  {#key activeIdx}
    <ChatLayout {token} {accounts} {activeIdx}
      onLogout={handleLogout} onSwitch={handleSwitch}
      onAddAccount={() => addingAccount = true} />
  {/key}
  {#if addingAccount}
    <div class="account-overlay" onclick={(e) => { if (e.target === e.currentTarget) addingAccount = false; }}>
      <Login onLogin={handleLogin} onCancel={() => addingAccount = false} />
    </div>
  {/if}
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
    --error:        #e06c75;
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
  :global(:root[data-theme="light"]) {
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
    --status-ok:    #009500;
    --error:        #c0392b;
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
  :global([data-theme="light"].high-contrast) {
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
  :global(body) {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 14px;
    background: var(--bg-primary);
    color: var(--text);
    height: 100svh;
    overflow: hidden;
  }
  :global(#app) { height: 100svh; display: flex; flex-direction: column; }
  :global(::-webkit-scrollbar) { width: 6px; }
  :global(::-webkit-scrollbar-track) { background: transparent; }
  :global(::-webkit-scrollbar-thumb) { background: var(--bg-elevated); border-radius: 3px; }

  :global(.high-contrast) :global(.prose pre),
  :global(.high-contrast) :global(.prose code),
  :global(.high-contrast) :global(.prose blockquote),
  :global(.high-contrast) :global(.prose th),
  :global(.high-contrast) :global(.prose td),
  :global(.high-contrast) :global(.tool) { border: none; }
  :global(.high-contrast) :global(.prose hr) { border-top: 1px solid var(--text-dim); }

  .account-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.6);
    display: flex; align-items: center; justify-content: center; z-index: 200;
  }
</style>
