// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import mermaid from 'mermaid';

let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
}

// Svelte action. Pass any reactive value as trigger so update() fires on content change.
export function mermaidRender(node, _trigger) {
  init();
  function run() {
    const nodes = [...node.querySelectorAll('.mermaid:not([data-processed])')];
    if (nodes.length) mermaid.run({ nodes }).catch(() => {});
  }
  setTimeout(run, 0);
  return { update() { setTimeout(run, 0); } };
}
