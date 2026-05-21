<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import ToolBlock from './ToolBlock.svelte';
  let { msg, onRespond = null, onOpenFile = null } = $props();

  // Map permission msg shape to what ToolBlock expects
  const tool = $derived({
    name: msg.toolName ?? msg.name,
    summary: msg.summary ?? null,
    input: msg.input ?? null,
    id: msg.toolId ?? null,
    result: msg.result ?? null,
  });
</script>

{#snippet permBadge()}
  {#if msg.resolved}
    <span class="tag" class:allowed={msg.decision === 'allowed'} class:denied={msg.decision === 'denied'}>
      {msg.decision}
    </span>
  {:else}
    <span class="tag pending">pending</span>
  {/if}
{/snippet}

<div class="perm" class:resolved={msg.resolved}>
  <ToolBlock {tool} running={false} {onOpenFile} badge={permBadge} />

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

  /* Embedded ToolBlock should have no extra border/margin */
  .perm :global(.tool) {
    border: none;
    border-radius: 0;
    margin-top: 0;
  }

  .tag {
    font-size: .7rem; padding: 1px 6px; border-radius: 99px;
  }
  .tag.pending { background: #78350f; color: #fcd34d; }
  .tag.allowed { background: #14532d; color: #86efac; }
  .tag.denied  { background: #7f1d1d; color: #fca5a5; }

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
