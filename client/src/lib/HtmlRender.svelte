<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  let { html } = $props();
  let collapsed = $state(false);
</script>

<div class="html-render">
  <div class="hr-header">
    <span class="hr-label">HTML</span>
    <button class="hr-toggle" onclick={() => collapsed = !collapsed}>
      {collapsed ? '▶' : '▼'}
    </button>
  </div>
  {#if !collapsed}
    <iframe
      srcdoc={html}
      sandbox="allow-scripts"
      title="rendered html"
      class="hr-frame"
    ></iframe>
  {/if}
</div>

<style>
  .html-render {
    border: 1px solid var(--border, #333);
    border-radius: 5px;
    overflow: hidden;
    margin: .5em 0;
  }
  .hr-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    background: var(--bg-elevated, #1a1a2e);
    font-size: .75rem;
    color: var(--text-muted, #888);
  }
  .hr-label { font-weight: 600; }
  .hr-toggle {
    background: none; border: none; color: var(--text-muted, #888);
    cursor: pointer; font-size: .7rem; padding: 2px 4px;
  }
  .hr-frame {
    width: 100%;
    height: 300px;
    border: none;
    background: #fff;
  }
</style>
