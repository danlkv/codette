// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { highlightLines } from './highlight.js';

// Svelte action: walks pre>code blocks in node and replaces with Shiki HTML.
// params: { theme: string|null, streaming?: boolean }
// - Skips blocks already highlighted with the current theme (data-hl=theme).
// - Skips all highlighting while streaming (to avoid thrashing on every chunk).
export function syntaxHighlight(node, params) {
  async function run({ theme, streaming } = {}) {
    if (streaming) return;
    if (!theme) {
      // Restore original plain text for any highlighted blocks
      node.querySelectorAll('pre > code[data-hl]').forEach(code => {
        if (code.dataset.original !== undefined) code.textContent = code.dataset.original;
        delete code.dataset.hl;
        delete code.dataset.original;
      });
      return;
    }
    const blocks = node.querySelectorAll('pre > code');
    for (const code of blocks) {
      if (code.dataset.hl === theme) continue;
      const langClass = [...code.classList].find(c => c.startsWith('language-'));
      const lang = langClass ? langClass.replace('language-', '') : null;
      // Save original before first highlight
      if (code.dataset.original === undefined) code.dataset.original = code.textContent ?? '';
      const text = code.dataset.original;
      try {
        const lines = await highlightLines(text, lang, theme);
        code.innerHTML = lines.join('\n');
        code.dataset.hl = theme;
      } catch {}
    }
  }

  run(params);
  return {
    update(newParams) { run(newParams); },
  };
}
