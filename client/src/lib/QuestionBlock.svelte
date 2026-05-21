<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  let { msg, onRespond = null } = $props();
  const interactive = $derived(!!onRespond && !msg.resolved);
  let answers = $state(msg.answers ? { ...msg.answers } : {});
  let otherText = $state({});
  let showOther = $state({});

  function select(q, label) {
    answers[q.question] = label;
    if (!msg.toolUseId) return; // non-interactive history
    // For single-select single-question, respond immediately
    const qs = msg.questions ?? msg.input?.questions ?? [];
    if (qs.length === 1 && !q.multiSelect) {
      onRespond(msg.toolUseId, true, { updatedInput: { answers: { ...answers } } });
    }
  }

  function submitOther(q) {
    const text = otherText[q.question]?.trim();
    if (!text) return;
    answers[q.question] = text;
    const qs = msg.questions ?? msg.input?.questions ?? [];
    if (qs.length === 1) {
      onRespond(msg.toolUseId, true, { updatedInput: { answers: { ...answers } } });
    }
  }

  function submitAll() {
    onRespond(msg.toolUseId, true, { updatedInput: { answers: { ...answers } } });
  }

  const questions = $derived(msg.questions ?? msg.input?.questions ?? []);
</script>

<div class="qblock" class:resolved={msg.resolved}>
  <div class="qheader">
    <span class="icon">&#x2753;</span>
    <span class="label">claude asked</span>
    <span class="spacer"></span>
    {#if !interactive && !msg.resolved}
      <span class="tag pending">auto-answered</span>
    {:else if msg.resolved}
      <span class="tag answered">answered</span>
    {:else}
      <span class="tag awaiting">awaiting</span>
    {/if}
  </div>
  {#each questions as q}
    <div class="question">
      {#if q.header}<div class="qchip">{q.header}</div>{/if}
      <div class="qtext">{q.question}</div>
      {#if q.options?.length}
        <div class="options">
          {#each q.options as opt}
            {#if interactive}
              <button class="opt clickable" class:selected={answers[q.question] === opt.label}
                onclick={() => select(q, opt.label)}>
                <span class="opt-label">{opt.label}</span>
                {#if opt.description}<span class="opt-desc">{opt.description}</span>{/if}
              </button>
            {:else}
              <div class="opt" class:selected={answers[q.question] === opt.label}>
                <span class="opt-label">{opt.label}</span>
                {#if opt.description}<span class="opt-desc">{opt.description}</span>{/if}
              </div>
            {/if}
          {/each}
          {#if interactive}
            {#if showOther[q.question]}
              <div class="opt other-input">
                <input type="text" placeholder="Type your answer..." bind:value={otherText[q.question]}
                  onkeydown={(e) => e.key === 'Enter' && submitOther(q)} />
                <button class="send-other" onclick={() => submitOther(q)}>Send</button>
              </div>
            {:else}
              <button class="opt other clickable" onclick={() => showOther[q.question] = true}>
                <span class="opt-label">Other...</span><span class="opt-desc">free text</span>
              </button>
            {/if}
          {:else}
            <div class="opt other"><span class="opt-label">Other...</span><span class="opt-desc">free text</span></div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
  {#if interactive && questions.length > 1}
    <div class="submit-row">
      <button class="btn-submit" onclick={submitAll}
        disabled={Object.keys(answers).length < questions.length}>Submit answers</button>
    </div>
  {/if}
</div>

<style>
  /* ── Active: B2 typed border (amber) ─────────────────────────────── */
  .qblock {
    border: 1px solid var(--q-border, #92400e);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-secondary);
  }
  /* ── Resolved: B3 neutral border, tinted header fades ────────────── */
  .qblock.resolved {
    border-color: var(--border);
    opacity: 0.65;
  }

  .qheader {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    font-size: .8rem; color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  .icon { font-size: .85rem; }
  .label { color: var(--q-label, #f59e0b); font-weight: 500; }
  .spacer { flex: 1; }

  .tag {
    font-size: .7rem; padding: 1px 6px; border-radius: 99px;
  }
  .tag.awaiting { background: #78350f; color: #fcd34d; }
  .tag.answered { background: #14532d; color: #86efac; }
  .tag.pending  { background: var(--bg-elevated); color: var(--text-muted); }

  .question { padding: 8px 12px; }
  .question + .question { border-top: 1px solid var(--border); }
  .qchip { font-size: .72rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: .03em; margin-bottom: 3px; }
  .qtext { color: var(--text); font-size: .86rem; margin-bottom: 8px; }

  .options { display: flex; flex-direction: column; gap: 3px; }
  .opt {
    display: flex; align-items: baseline; gap: 8px;
    padding: 5px 10px;
    border: 1px solid var(--border); border-radius: 5px;
    background: var(--bg-primary);
  }
  .opt.clickable {
    cursor: pointer; transition: border-color .15s, background .15s;
    width: 100%; text-align: left; color: inherit; font: inherit;
  }
  .opt.clickable:hover { border-color: var(--q-border, #92400e); background: var(--bg-elevated); }
  .opt.selected { border-color: #22c55e; background: var(--bg-elevated); }
  .opt-label { font-size: .8rem; color: var(--text); font-weight: 500; }
  .opt-desc  { font-size: .74rem; color: var(--text-muted); }
  .other .opt-label { color: var(--text-muted); font-style: italic; }

  .other-input {
    display: flex; gap: 6px; padding: 4px 6px;
  }
  .other-input input {
    flex: 1; padding: 4px 8px; border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--text); font-size: .8rem;
  }
  .send-other {
    padding: 4px 10px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg-primary); color: #22c55e;
    font-size: .75rem;
  }
  .send-other:hover { border-color: #22c55e; }

  .submit-row { padding: 8px 12px; border-top: 1px solid var(--border); }
  .btn-submit {
    width: 100%; padding: 5px; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg-primary); color: #22c55e;
    font-size: .8rem; font-weight: 500;
  }
  .btn-submit:hover { border-color: #22c55e; }
  .btn-submit:disabled { opacity: 0.4; cursor: default; }

  /* ── Light mode ──────────────────────────────────────────────────── */
  :global(:root[data-theme="light"]) .qblock     { --q-border: #d97706; --q-label: #b45309; }
  :global(:root[data-theme="light"]) .tag.awaiting { background: #fef3c7; color: #92400e; }
  :global(:root[data-theme="light"]) .tag.answered { background: #dcfce7; color: #065f46; }
  :global(:root[data-theme="light"]) .send-other { color: #166534; }
  :global(:root[data-theme="light"]) .btn-submit { color: #166534; }

  /* ── High contrast dark ──────────────────────────────────────────── */
  :global(.high-contrast) .qblock { --q-border: #ffaa00; --q-label: #ffcc44; }
  :global(.high-contrast) .tag.awaiting { background: #664400; color: #ffdd66; }
  :global(.high-contrast) .tag.answered { background: #004400; color: #66ff66; }
  :global(.high-contrast) .opt.clickable:hover { border-color: #ffaa00; }
  :global(.high-contrast) .opt.selected { border-color: #44ff44; }
  :global(.high-contrast) .send-other { color: #44ff44; }
  :global(.high-contrast) .btn-submit { color: #44ff44; }

  /* ── High contrast light ─────────────────────────────────────────── */
  :global([data-theme="light"].high-contrast) .qblock { --q-border: #b84400; --q-label: #8b3a00; }
  :global([data-theme="light"].high-contrast) .tag.awaiting { background: #fde68a; color: #7a3d00; }
  :global([data-theme="light"].high-contrast) .tag.answered { background: #bbf7d0; color: #004d00; }
  :global([data-theme="light"].high-contrast) .opt.clickable:hover { border-color: #b84400; }
  :global([data-theme="light"].high-contrast) .opt.selected { border-color: #006600; }
  :global([data-theme="light"].high-contrast) .send-other { color: #006600; }
  :global([data-theme="light"].high-contrast) .btn-submit { color: #006600; }
</style>
