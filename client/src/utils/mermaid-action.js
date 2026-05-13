// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import mermaid from 'mermaid';

function getConfig() {
  const s = getComputedStyle(document.documentElement);
  const v = name => s.getPropertyValue(name).trim();
  const forced = document.documentElement.getAttribute('data-theme');
  const dark = forced === 'dark' || (!forced && !window.matchMedia('(prefers-color-scheme: light)').matches);
  return {
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'loose',
    themeVariables: {
      darkMode: dark,
      background:          v('--bg-primary'),
      mainBkg:             v('--bg-elevated'),
      primaryColor:        v('--bg-elevated'),
      primaryTextColor:    v('--text'),
      primaryBorderColor:  v('--border'),
      lineColor:           v('--text-muted'),
      secondaryColor:      v('--bg-secondary'),
      tertiaryColor:       v('--bg-elevated'),
      edgeLabelBackground: v('--bg-secondary'),
      clusterBkg:          v('--bg-elevated'),
      clusterBorder:       v('--border'),
      titleColor:          v('--text'),
      nodeTextColor:       v('--text'),
      activationBkgColor:  v('--bg-elevated'),
      activationBorderColor: v('--accent'),
      noteBkgColor:        v('--bg-secondary'),
      noteBorderColor:     v('--border'),
      noteTextColor:       v('--text-muted'),
      fontSize:            '13px',
    },
  };
}

function openFullscreen(mermaidEl) {
  const svg = mermaidEl.querySelector('svg');
  if (!svg) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:24px;box-sizing:border-box;';
  const clone = svg.cloneNode(true);
  // Remove fixed dimensions so it scales to viewport
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  clone.style.cssText = 'max-width:100%;max-height:100%;width:auto;height:auto;background:var(--bg-primary);border-radius:6px;padding:16px;cursor:default;display:block;';
  clone.addEventListener('click', e => e.stopPropagation());
  overlay.appendChild(clone);
  overlay.addEventListener('click', () => overlay.remove());
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(overlay);
}

function wrapWithToggle(mermaidEl, source) {
  const wrap = document.createElement('div');
  wrap.className = 'mermaid-wrap';

  const btn = document.createElement('button');
  btn.className = 'mermaid-toggle';
  btn.textContent = 'source';
  btn.title = 'Toggle diagram source';

  const fsBtn = document.createElement('button');
  fsBtn.className = 'mermaid-toggle';
  fsBtn.textContent = '⤢';
  fsBtn.title = 'Fullscreen';
  fsBtn.addEventListener('click', () => openFullscreen(mermaidEl));

  const zoomIn = document.createElement('button');
  zoomIn.className = 'mermaid-toggle';
  zoomIn.textContent = '+';
  zoomIn.title = 'Zoom in';

  const zoomOut = document.createElement('button');
  zoomOut.className = 'mermaid-toggle';
  zoomOut.textContent = '−';
  zoomOut.title = 'Zoom out';

  const pre = document.createElement('pre');
  pre.className = 'mermaid-source';
  pre.textContent = source;
  pre.style.display = 'none';

  const controls = document.createElement('div');
  controls.className = 'mermaid-controls';
  controls.appendChild(zoomOut);
  controls.appendChild(zoomIn);
  controls.appendChild(fsBtn);
  controls.appendChild(btn);

  mermaidEl.parentNode.insertBefore(wrap, mermaidEl);
  wrap.appendChild(mermaidEl);
  wrap.appendChild(pre);
  wrap.appendChild(controls);

  let zoom = 700;
  const applyZoom = () => {
    const svg = mermaidEl.querySelector('svg');
    if (svg) svg.style.width = zoom + 'px';
  };
  zoomIn.addEventListener('click', () => { zoom = Math.min(zoom + 150, 2400); applyZoom(); });
  zoomOut.addEventListener('click', () => { zoom = Math.max(zoom - 150, 300); applyZoom(); });

  btn.addEventListener('click', () => {
    const showingSource = pre.style.display !== 'none';
    pre.style.display = showingSource ? 'none' : '';
    mermaidEl.style.display = showingSource ? '' : 'none';
    btn.textContent = showingSource ? 'source' : 'diagram';
  });
}

// Svelte action. Pass any reactive value as trigger so update() fires on content change.
export function mermaidRender(node, _trigger) {
  function run() {
    const els = [...node.querySelectorAll('.mermaid:not([data-processed])')];
    if (!els.length) return;
    // Save sources before mermaid mutates the divs
    const sources = els.map(el => el.textContent.trim());
    mermaid.initialize(getConfig());
    mermaid.run({ nodes: els }).then(() => {
      els.forEach((el, i) => {
        if (!el.closest('.mermaid-wrap')) wrapWithToggle(el, sources[i]);
      });
    }).catch(() => {});
  }
  setTimeout(run, 0);
  return { update() { setTimeout(run, 0); } };
}
