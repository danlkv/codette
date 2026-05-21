<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import { toolIcon } from '../utils/tools.js';
  let { msg, onRespond = null } = $props();
  let open = $state(false);
  const inputStr = msg.input ? JSON.stringify(msg.input, null, 2) : '';
</script>

<div class="perm" class:resolved={msg.resolved}>
  <div class="pheader">
    <span class="icon">{toolIcon(msg.toolName)}</span>
    <span class="name">{msg.displayName || msg.toolName}</span>
    {#if msg.title}<span class="title">{msg.title}</span>{/if}
    <span class="spacer"></span>
    {#if msg.resolved}
      <span class="tag" class:allowed={msg.decision === 'allowed'} class:denied={msg.decision === 'denied'}>
        {msg.decision}
      </span>
    {:else}
      <span class="tag pending">pending</span>
    {/if}
    <button class="chevron" onclick={() => open = !open}>{open ? '▾' : '▸'}</button>
  </div>

  {#if open && inputStr}
    <pre class="detail">{inputStr}</pre>
  {/if}

  {#if !msg.resolved && onRespond}
    <div class="actions">
      <button class="btn allow" onclick={() => onRespond(msg.toolUseId, true)}>Allow</button>
      <button class="btn deny" onclick={() => onRespond(msg.toolUseId, false, { message: 'denied by user' })}>Deny</button>
    </div>
  {/if}
</div>

<style>
  /* ── Active: amber typed border (needs user action) ───────────────── */
  .perm {
    border: 1px solid var(--pm-border, #92400e);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-secondary);
  }
  /* ── Resolved: neutral border, faded ─────────────────────────────── */
  .perm.resolved {
    border-color: var(--border);
    opacity: 0.65;
  }

  .pheader {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    font-size: .8rem; color: var(--text-muted);
  }
  .pheader:hover { background: var(--bg-elevated); }
  .icon { font-size: .85rem; }
  .name { color: var(--text); font-weight: 600; }
  .title { color: var(--text-dim); font-size: .75rem; }
  .spacer { flex: 1; }

  .tag {
    font-size: .7rem; padding: 1px 6px; border-radius: 99px;
  }
  .tag.pending { background: #78350f; color: #fcd34d; }
  .tag.allowed { background: #14532d; color: #86efac; }
  .tag.denied  { background: #7f1d1d; color: #fca5a5; }

  .chevron {
    background: none; border: none; color: var(--text-dim);
    cursor: pointer; font-size: .7rem; padding: 0 4px;
  }

  .detail {
    padding: 8px 12px; margin: 0;
    font-size: .72rem; color: var(--text-muted);
    background: var(--bg-primary);
    border-top: 1px solid var(--border);
    max-height: 200px; overflow: auto;
    white-space: pre-wrap; word-break: break-word;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .actions {
    display: flex; gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
  }
  .btn {
    flex: 1; padding: 5px 0;
    border: 1px solid var(--border); border-radius: 5px;
    font-size: .8rem; font-weight: 500;
    cursor: pointer; transition: opacity .15s;
    background: var(--bg-primary);
  }
  .btn:hover { opacity: 0.85; }
  .btn.allow { color: #22c55e; }
  .btn.allow:hover { border-color: #22c55e; }
  .btn.deny  { color: #ef4444; }
  .btn.deny:hover  { border-color: #ef4444; }

  /* ── Light mode ──────────────────────────────────────────────────── */
  :global(:root[data-theme="light"]) .perm { --pm-border: #d97706; }
  :global(:root[data-theme="light"]) .tag.pending { background: #fef3c7; color: #92400e; }
  :global(:root[data-theme="light"]) .tag.allowed { background: #dcfce7; color: #065f46; }
  :global(:root[data-theme="light"]) .tag.denied  { background: #fee2e2; color: #991b1b; }
  :global(:root[data-theme="light"]) .btn.allow { color: #166534; }
  :global(:root[data-theme="light"]) .btn.deny  { color: #991b1b; }

  /* ── High contrast dark ──────────────────────────────────────────── */
  :global(.high-contrast) .perm { --pm-border: #ffaa00; }
  :global(.high-contrast) .tag.pending { background: #664400; color: #ffdd66; }
  :global(.high-contrast) .tag.allowed { background: #004400; color: #66ff66; }
  :global(.high-contrast) .tag.denied  { background: #660000; color: #ff6666; }
  :global(.high-contrast) .btn.allow { color: #44ff44; }
  :global(.high-contrast) .btn.allow:hover { border-color: #44ff44; }
  :global(.high-contrast) .btn.deny  { color: #ff4444; }
  :global(.high-contrast) .btn.deny:hover  { border-color: #ff4444; }

  /* ── High contrast light ─────────────────────────────────────────── */
  :global([data-theme="light"].high-contrast) .perm { --pm-border: #b84400; }
  :global([data-theme="light"].high-contrast) .tag.pending { background: #fde68a; color: #7a3d00; }
  :global([data-theme="light"].high-contrast) .tag.allowed { background: #bbf7d0; color: #004d00; }
  :global([data-theme="light"].high-contrast) .tag.denied  { background: #fecaca; color: #7f0000; }
  :global([data-theme="light"].high-contrast) .btn.allow { color: #006600; }
  :global([data-theme="light"].high-contrast) .btn.allow:hover { border-color: #006600; }
  :global([data-theme="light"].high-contrast) .btn.deny  { color: #990000; }
  :global([data-theme="light"].high-contrast) .btn.deny:hover  { border-color: #990000; }
</style>
