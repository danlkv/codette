<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { hmacSign, deriveAuthKey } from '../utils/crypto.js';
  import { wtrace } from '../utils/trace.js';

  let { onLogin, onCancel } = $props();
  let username = $state(''), password = $state(''), error = $state(''), loading = $state(false);
  let hostDown = $state(false);
  let showPassword = $state(false);

  async function submit() {
    loading = true; error = ''; hostDown = false;
    try {
      const post = (url, body) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      wtrace('client', 'server', 'auth_challenge');
      const chalRes = await post('/api/auth/challenge', { username });
      if (!chalRes.ok) { hostDown = true; return; }
      const { nonce } = await chalRes.json();

      // Run the password through PBKDF2 (200k iters) before HMAC so the value
      // we POST to the relay server is not a raw HMAC-of-password — that would
      // be brute-forceable at full HMAC speed by anyone who saw the request.
      const authKey = await deriveAuthKey(password, username);
      const response = await hmacSign(authKey, nonce);

      wtrace('client', 'server', 'auth_verify');
      const verRes = await post('/api/auth/verify', { username, nonce, response });
      if (verRes.ok) {
        const { token } = await verRes.json();
        wtrace('client', 'server', 'auth_verify_ok');
        onLogin?.(token, { password, username });
      } else error = 'Invalid credentials';
    } catch { error = 'Connection error'; }
    finally { loading = false; }
  }
</script>

<div class="wrap">
  <div class="card">
    <div class="brand">codette</div>
    <form onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <label>
        <span>Username</span>
        <input bind:value={username} autocomplete="username" required />
      </label>
      <label>
        <span>Password</span>
        <div class="pw-wrap">
          <button type="button" class="pw-toggle" onclick={() => showPassword = !showPassword}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}>
            {#if showPassword}
              <!-- eye-off -->
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.6 19.6 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.6 19.6 0 0 1-3.17 4.19M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            {:else}
              <!-- eye -->
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            {/if}
          </button>
          <input bind:value={password} type={showPassword ? 'text' : 'password'} autocomplete="current-password" required />
        </div>
      </label>
      {#if error}<p class="err">{error}</p>{/if}
      {#if hostDown}<p class="err">Host not connected</p>{/if}
      <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
      {#if onCancel}<button type="button" class="cancel" onclick={onCancel}>cancel</button>{/if}
    </form>
    <div class="install-hint">
      <p class="hint">Install host:</p>
      <code class="install-cmd">curl -fsSL {location.origin}/install.sh | sh</code>
    </div>
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
  .install-hint { text-align: center; }
  .install-hint .hint { font-size: .78rem; color: var(--text-muted); margin-bottom: 6px; }
  .install-cmd {
    display: block; background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px 12px; font-size: .82rem; color: var(--text);
    word-break: break-all; user-select: all; cursor: text;
  }
  .cancel { border-color: var(--border); color: var(--text-dim); margin-top: 0; }
  .pw-wrap { position: relative; display: flex; }
  /* Just enough padding for the eye itself. Bitwarden reads padding-right to
     decide its overlay position and will park immediately inboard of the eye. */
  .pw-wrap input { flex: 1; padding-right: 32px; }
  .pw-toggle {
    position: absolute; top: 50%; right: 6px; transform: translateY(-50%);
    background: none; border: none; color: var(--text-muted); padding: 4px;
    cursor: pointer; margin-top: 0; border-radius: 4px;
    display: inline-flex; align-items: center;
  }
  .pw-toggle:hover { color: var(--text); border-color: transparent; }
  /* Hide Edge's built-in reveal so it doesn't duplicate our button. */
  .pw-wrap input::-ms-reveal { display: none; }
</style>
