<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  let { msg, onRespond = null, onOpenFile = null } = $props();
  const interactive = $derived(!!onRespond && !msg.resolved);
  let rejectMsg = $state('');
  let showRejectInput = $state(false);
</script>

<div class="plan" class:resolved={msg.resolved}>
  <div class="pheader">
    <span class="icon">&#x1F4CB;</span>
    <span class="label">plan approval</span>
    <span class="spacer"></span>
    {#if msg.planFile && onOpenFile}
      <button class="view-plan" onclick={() => onOpenFile(msg.planFile)}>view plan</button>
    {/if}
    {#if msg.resolved}
      <span class="tag" class:approved={msg.decision === 'allowed'} class:rejected={msg.decision === 'denied'}>
        {msg.decision === 'allowed' ? 'approved' : 'rejected'}
      </span>
    {:else}
      <span class="tag awaiting">awaiting</span>
    {/if}
  </div>

  {#if msg.input?.allowedPrompts?.length}
    <div class="steps">
      {#each msg.input.allowedPrompts as p}
        <div class="step">
          <span class="step-tool">{p.tool ?? ''}</span>
          <span class="step-text">{p.prompt ?? ''}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if interactive}
    <div class="actions">
      <button class="btn approve" onclick={() => onRespond(msg.toolUseId, true)}>Approve</button>
      {#if showRejectInput}
        <div class="reject-row">
          <input type="text" placeholder="Feedback (optional)" bind:value={rejectMsg}
            onkeydown={(e) => e.key === 'Enter' && onRespond(msg.toolUseId, false, { message: rejectMsg || 'rejected by user' })} />
          <button class="btn reject" onclick={() => onRespond(msg.toolUseId, false, { message: rejectMsg || 'rejected by user' })}>
            Reject
          </button>
        </div>
      {:else}
        <button class="btn reject" onclick={() => showRejectInput = true}>Reject</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* ── Active: B2 typed border (blue) ──────────────────────────────── */
  .plan {
    border: 1px solid var(--pl-border, #1e40af);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-secondary);
  }
  /* ── Resolved: B3 neutral border ─────────────────────────────────── */
  .plan.resolved {
    border-color: var(--border);
    opacity: 0.65;
  }

  .pheader {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    font-size: .8rem; color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  .icon { font-size: .85rem; }
  .label { color: var(--pl-label, #60a5fa); font-weight: 500; }
  .spacer { flex: 1; }

  .view-plan {
    font: .7rem/1 inherit; background: none; border: 1px solid var(--border);
    border-radius: 4px; padding: 1px 6px; cursor: pointer;
    color: var(--pl-label, #60a5fa); white-space: nowrap;
  }
  .view-plan:hover { border-color: var(--pl-label, #60a5fa); }

  .tag {
    font-size: .7rem; padding: 1px 6px; border-radius: 99px;
  }
  .tag.awaiting { background: #1e3a5f; color: #93c5fd; }
  .tag.approved { background: #14532d; color: #86efac; }
  .tag.rejected { background: #7f1d1d; color: #fca5a5; }

  .steps {
    padding: 8px 12px;
    font-size: .78rem;
  }
  .step {
    display: flex; gap: 8px; padding: 2px 0;
  }
  .step-tool {
    color: var(--pl-label, #60a5fa); font-weight: 500;
    min-width: 50px; font-size: .78rem;
  }
  .step-text { color: var(--text-muted); }

  .actions {
    display: flex; gap: 8px; flex-wrap: wrap;
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
  .btn.approve { color: #22c55e; }
  .btn.approve:hover { border-color: #22c55e; }
  .btn.reject  { color: #ef4444; }
  .btn.reject:hover  { border-color: #ef4444; }

  .reject-row {
    display: flex; gap: 6px; flex: 2;
  }
  .reject-row input {
    flex: 1; padding: 4px 8px; border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--text); font-size: .78rem;
  }

  /* ── Light mode ──────────────────────────────────────────────────── */
  :global(:root[data-theme="light"]) .plan { --pl-border: #3b82f6; --pl-label: #2563eb; }
  :global(:root[data-theme="light"]) .tag.awaiting { background: #dbeafe; color: #1e40af; }
  :global(:root[data-theme="light"]) .tag.approved { background: #dcfce7; color: #065f46; }
  :global(:root[data-theme="light"]) .tag.rejected { background: #fee2e2; color: #991b1b; }
  :global(:root[data-theme="light"]) .btn.approve { color: #166534; }
  :global(:root[data-theme="light"]) .btn.reject  { color: #991b1b; }

  /* ── High contrast dark ──────────────────────────────────────────── */
  :global(.high-contrast) .plan { --pl-border: #66aaff; --pl-label: #99ccff; }
  :global(.high-contrast) .tag.awaiting { background: #003366; color: #99ccff; }
  :global(.high-contrast) .tag.approved { background: #004400; color: #66ff66; }
  :global(.high-contrast) .tag.rejected { background: #660000; color: #ff6666; }
  :global(.high-contrast) .btn.approve { color: #44ff44; }
  :global(.high-contrast) .btn.approve:hover { border-color: #44ff44; }
  :global(.high-contrast) .btn.reject  { color: #ff4444; }
  :global(.high-contrast) .btn.reject:hover  { border-color: #ff4444; }

  /* ── High contrast light ─────────────────────────────────────────── */
  :global([data-theme="light"].high-contrast) .plan { --pl-border: #0044cc; --pl-label: #003399; }
  :global([data-theme="light"].high-contrast) .tag.awaiting { background: #cce0ff; color: #003399; }
  :global([data-theme="light"].high-contrast) .tag.approved { background: #bbf7d0; color: #004d00; }
  :global([data-theme="light"].high-contrast) .tag.rejected { background: #fecaca; color: #7f0000; }
  :global([data-theme="light"].high-contrast) .btn.approve { color: #006600; }
  :global([data-theme="light"].high-contrast) .btn.approve:hover { border-color: #006600; }
  :global([data-theme="light"].high-contrast) .btn.reject  { color: #990000; }
  :global([data-theme="light"].high-contrast) .btn.reject:hover  { border-color: #990000; }
</style>
