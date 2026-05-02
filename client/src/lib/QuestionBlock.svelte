<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  export let msg; // { questions: [{question, header, options, multiSelect}] }
</script>

<div class="qblock">
  <div class="qheader">
    <span class="icon">❓</span>
    <span class="label">claude asked</span>
    <span class="note">auto-answered (non-interactive)</span>
  </div>
  {#each msg.questions as q}
    <div class="question">
      {#if q.header}<div class="qhead">{q.header}</div>{/if}
      <div class="qtext">{q.question}</div>
      {#if q.options?.length}
        <div class="options">
          {#each q.options as opt}
            <div class="opt">
              <span class="opt-label">{opt.label}</span>
              {#if opt.description}<span class="opt-desc">{opt.description}</span>{/if}
            </div>
          {/each}
          <div class="opt other"><span class="opt-label">Other…</span><span class="opt-desc">free text</span></div>
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .qblock {
    border: 1px solid #92400e;
    border-radius: 8px;
    overflow: hidden;
    background: #1c1208;
  }
  .qheader {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    background: #291a0a;
    border-bottom: 1px solid #92400e;
    font-size: .78rem;
  }
  .icon { font-size: .9rem; }
  .label { color: #f59e0b; font-weight: 500; }
  .note  { color: #78350f; margin-left: auto; font-size: .72rem; }

  .question { padding: 10px 12px; }
  .question + .question { border-top: 1px solid #2d1a06; }
  .qhead { font-size: .78rem; color: #d97706; font-weight: 500; margin-bottom: 4px; }
  .qtext { color: #fcd34d; font-size: .88rem; margin-bottom: 8px; }

  .options { display: flex; flex-direction: column; gap: 4px; }
  .opt {
    display: flex; align-items: baseline; gap: 8px;
    padding: 4px 8px;
    border: 1px solid #2d1a06; border-radius: 5px;
    background: #1a1005;
  }
  .opt-label { font-size: .8rem; color: #fbbf24; }
  .opt-desc  { font-size: .75rem; color: #a78040; }
  .other .opt-label { color: #d97706; font-style: italic; }
</style>
