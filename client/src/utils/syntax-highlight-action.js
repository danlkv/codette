// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { highlightLines } from './highlight.js';

function addCopyButton(pre, code) {
  if (pre.querySelector('.copy-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = 'copy';
  btn.addEventListener('click', () => {
    const text = code.dataset.original ?? code.textContent ?? '';
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = 'copy'; }, 1500);
    });
  });
  pre.appendChild(btn);
}

// Svelte action: walks pre>code blocks in node and replaces with Shiki HTML.
// params: { theme: string|null, streaming?: boolean }
// - Skips blocks already highlighted with the current theme (data-hl=theme).
// - Skips all highlighting while streaming (to avoid thrashing on every chunk).
export function syntaxHighlight(node, params) {
  async function run({ theme, streaming } = {}) {
    if (streaming) return;
    const blocks = node.querySelectorAll('pre > code');
    if (!theme) {
      blocks.forEach(code => {
        addCopyButton(code.parentElement, code);
        if (code.dataset.original !== undefined) code.textContent = code.dataset.original;
        delete code.dataset.hl;
        delete code.dataset.original;
      });
      return;
    }
    for (const code of blocks) {
      addCopyButton(code.parentElement, code);
      if (code.dataset.hl === theme) continue;
      const langClass = [...code.classList].find(c => c.startsWith('language-'));
      const lang = langClass ? langClass.replace('language-', '') : null;
      // Save original before first highlight
      if (code.dataset.original === undefined) code.dataset.original = code.textContent ?? '';
      const text = code.dataset.original;
      try {
        const { lines, bg, fg } = await highlightLines(text, lang, theme);
        code.innerHTML = lines.join('\n');
        code.dataset.hl = theme;
        code.parentElement.style.background = bg;
        if (fg) code.style.color = fg;
      } catch {}
    }
  }

  run(params);
  return {
    update(newParams) { run(newParams); },
  };
}
