<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  let { html } = $props();
  let collapsed = $state(false);
  let iframeEl = $state(null);
  let height = $state(300);

  // Inject a small script that posts the document height back to the parent
  const resizeScript = `<script>
    function _hrResize() {
      var h = document.documentElement.scrollHeight;
      parent.postMessage({ __hrResize: true, height: h }, '*');
    }
    window.addEventListener('load', _hrResize);
    new MutationObserver(_hrResize).observe(document.body, { childList: true, subtree: true, attributes: true });
    setTimeout(_hrResize, 100);
  <\/script>`;

  const baseStyle = '<style>body{background:transparent;margin:0}</style>';
  let srcdoc = $derived(baseStyle + html + resizeScript);

  $effect(() => {
    if (!iframeEl) return;
    function onMsg(e) {
      if (e.source !== iframeEl.contentWindow) return;
      if (e.data?.__hrResize) {
        height = Math.min(Math.max(e.data.height + 4, 60), 800);
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
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
      srcdoc={srcdoc}
      sandbox="allow-scripts"
      title="rendered html"
      class="hr-frame"
      style="height: {height}px"
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
    border: none;
    background: transparent;
  }
</style>
