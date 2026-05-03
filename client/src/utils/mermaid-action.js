// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import mermaid from 'mermaid';

function getConfig() {
  const s = getComputedStyle(document.documentElement);
  const v = name => s.getPropertyValue(name).trim();
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
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
      fontSize:            '13px',
    },
  };
}

function wrapWithToggle(mermaidEl, source) {
  const wrap = document.createElement('div');
  wrap.className = 'mermaid-wrap';

  const btn = document.createElement('button');
  btn.className = 'mermaid-toggle';
  btn.textContent = 'source';
  btn.title = 'Toggle diagram source';

  const pre = document.createElement('pre');
  pre.className = 'mermaid-source';
  pre.textContent = source;
  pre.style.display = 'none';

  mermaidEl.parentNode.insertBefore(wrap, mermaidEl);
  wrap.appendChild(mermaidEl);
  wrap.appendChild(pre);
  wrap.appendChild(btn);

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
