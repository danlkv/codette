<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  let { html } = $props();
  let collapsed = $state(false);
  let iframeEl = $state(null);

  function resize() {
    if (!iframeEl) return;
    try {
      const h = iframeEl.contentDocument?.documentElement?.scrollHeight;
      if (h) iframeEl.style.height = Math.min(h + 4, 600) + 'px';
    } catch { /* cross-origin fallback: keep default height */ }
  }

  $effect(() => {
    if (!iframeEl || !html) return;
    const doc = iframeEl.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(html);
    doc.close();
    // resize once loaded
    iframeEl.addEventListener('load', resize, { once: true });
    // also resize after a tick for synchronous content
    setTimeout(resize, 50);
  });
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
      bind:this={iframeEl}
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
