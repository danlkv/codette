<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();
  let username = '', password = '', error = '', loading = false;

  async function submit() {
    loading = true; error = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) dispatch('login', (await res.json()).token);
      else error = 'Invalid credentials';
    } catch { error = 'Connection error'; }
    finally { loading = false; }
  }
</script>

<div class="wrap">
  <div class="card">
    <div class="brand">claude</div>
    <form on:submit|preventDefault={submit}>
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
    </form>
  </div>
</div>

<style>
  .wrap {
    display: flex; align-items: center; justify-content: center;
    height: var(--app-height, 100dvh); background: var(--bg-primary);
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
</style>
