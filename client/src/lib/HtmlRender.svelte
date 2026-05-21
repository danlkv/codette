<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  let { html } = $props();
  let collapsed = $state(false);
  let iframeEl = $state(null);
  let height = $state(300);

  // TODO: auto-resize still feedback-loops for HTML using viewport-relative
  // units (100dvh, 100vh). body.offsetHeight matches viewport → parent sets
  // same → stable in theory, but in practice some content triggers +1 drift.
  // Possible fixes: measure once then stop, or detect viewport-unit usage and
  // skip auto-resize (use fixed height + internal scroll).

  // Inject a resize script that posts body height to parent.
  // Uses document.body.offsetHeight (content-driven with height:auto).
  // No +N padding — that caused feedback loops with viewport-relative content.
  // Same-value guard (_hrLast) ensures stability:
  //   - Small content: body shrinks to content → stable
  //   - Viewport content (100dvh): body = viewport height → set same → stable
  // No #_hr wrapper — full HTML documents (<!DOCTYPE>) can't nest in a div.
  const resizeScript = `<script>
    var _hrLast = -1, _hrN = 0;
    function _hrPost() {
      var h = document.body.offsetHeight;
      if (h === _hrLast) return;
      _hrLast = h;
      var n = ++_hrN;
      console.log('[hr-iframe] resize #' + n, { height: h });
      parent.postMessage({ __hrResize: true, height: h }, '*');
    }
    new ResizeObserver(function() { _hrPost(); }).observe(document.body);
    window.addEventListener('load', _hrPost);
    setTimeout(_hrPost, 200);
  <\/script>`;

  const baseStyle = '<style>html,body{background:transparent;margin:0}</style>';
  let srcdoc = $derived(baseStyle + html + resizeScript);

  $effect(() => {
    if (!iframeEl) return;
    const iframeId = Math.random().toString(36).slice(2, 6);
    console.log('[hr-parent] effect setup, iframe:', iframeId);
    function onMsg(e) {
      if (e.source !== iframeEl.contentWindow) return;
      if (e.data?.__hrResize) {
        const newH = Math.min(Math.max(e.data.height, 40), 800);
        console.log('[hr-parent] resize msg', iframeId, { raw: e.data.height, clamped: newH, prev: height });
        height = newH;
      }
    }
    window.addEventListener('message', onMsg);
    return () => {
      console.log('[hr-parent] cleanup listener', iframeId);
      window.removeEventListener('message', onMsg);
    };
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
    <!-- Wrapper div absorbs dynamic height so the iframe element's attributes
         never change after mount (prevents browser iframe reloads). -->
    <div class="hr-frame-wrap" style="height: {height}px">
      <iframe
        bind:this={iframeEl}
        srcdoc={srcdoc}
        sandbox="allow-scripts"
        title="rendered html"
        class="hr-frame"
      ></iframe>
    </div>
  {/if}
</div>

<style>
  .html-render {
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
  .hr-frame-wrap {
    overflow: hidden;
  }
  .hr-frame {
    width: 100%;
    height: 100%;
    border: none;
    background: transparent;
  }
</style>
