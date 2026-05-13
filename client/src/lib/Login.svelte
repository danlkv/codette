<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { hmacSign } from '../utils/crypto.js';
  import { wtrace } from '../utils/trace.js';

  let { onLogin, onCancel } = $props();
  let username = $state(''), password = $state(''), error = $state(''), loading = $state(false);

  async function submit() {
    loading = true; error = '';
    try {
      const post = (url, body) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      wtrace('client', 'server', 'auth_challenge');
      const chalRes = await post('/api/auth/challenge', { username });
      if (!chalRes.ok) { error = 'Host not connected'; return; }
      const { nonce } = await chalRes.json();

      const response = await hmacSign(password, nonce);

      wtrace('client', 'server', 'auth_verify');
      const verRes = await post('/api/auth/verify', { username, nonce, response });
      if (verRes.ok) onLogin?.((await verRes.json()).token);
      else error = 'Invalid credentials';
    } catch { error = 'Connection error'; }
    finally { loading = false; }
  }
</script>

<div class="wrap">
  <div class="card">
    <div class="brand">claude</div>
    <form onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <label>
        <span>Username</span>
        <input bind:value={username} autocomplete="username" required />
      </label>
      <label>
        <span>Password</span>
        <input bind:value={password} type="password" autocomplete="current-password" required />
      </label>
      {#if error}<p class="err">{error}</p>{/if}
      <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
      {#if onCancel}<button type="button" class="cancel" onclick={onCancel}>cancel</button>{/if}
    </form>
  </div>
</div>

<style>
  .wrap {
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    width: 320px; background: var(--bg-secondary);
    border: 1px solid var(--border); border-radius: 12px;
    padding: 28px 24px; display: flex; flex-direction: column; gap: 20px;
  }
  .brand {
    color: var(--accent); font-size: 1rem; font-weight: 600;
    text-align: center; letter-spacing: .05em;
  }
  form { display: flex; flex-direction: column; gap: 12px; }
  label { display: flex; flex-direction: column; gap: 4px; }
  label span { font-size: .78rem; color: var(--text-muted); }
  input {
    background: var(--bg-elevated); border: 1px solid var(--border);
    color: var(--text); padding: 8px 11px; border-radius: 7px; font: inherit;
  }
  input:focus { outline: none; border-color: var(--accent-light); }
  button {
    background: none; border: 1px solid var(--accent); color: var(--accent);
    padding: 9px; border-radius: 6px; cursor: pointer; font: inherit;
    margin-top: 4px; transition: color .15s, border-color .15s;
  }
  button:hover:not(:disabled) { color: var(--accent-light); border-color: var(--accent-light); }
  button:disabled { opacity: .5; cursor: default; }
  .err { color: #f87171; font-size: .82rem; }
  .cancel { border-color: var(--border); color: var(--text-dim); margin-top: 0; }
</style>
