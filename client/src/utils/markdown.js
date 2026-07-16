// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Store htmlrender content out-of-band so DOMPurify can't strip it.
// Content-keyed: same HTML always gets the same ID (prevents duplication
// when renderMd is called multiple times for the same message).
let _hrId = 0;
export const htmlRenderStore = new Map();   // id → html
const _hrContentKey = new Map();            // html → id

function renderMath(tex, display) {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
  } catch {
    return esc(display ? `$$${tex}$$` : `$${tex}$`);
  }
}

// marked extension: tokenize $$...$$ (block) and $...$ (inline) before other rules
marked.use({
  extensions: [{
    name: 'math_block',
    level: 'block',
    start(src) { return src.indexOf('$$'); },
    tokenizer(src) {
      const m = src.match(/^\$\$([^$]*?)\$\$/s);
      if (m) return { type: 'math_block', raw: m[0], text: m[1].trim() };
    },
    renderer(token) {
      return `<div class="math-block">${renderMath(token.text, true)}</div>`;
    },
  }, {
    name: 'math_inline',
    level: 'inline',
    start(src) { return src.indexOf('$'); },
    tokenizer(src) {
      // avoid matching $$ and don't span newlines; pandoc boundary rules:
      // non-space after opening $, non-space before closing $, no digit
      // after closing $ — so currency pairs ("$2 and $3") stay literal
      const m = src.match(/^\$(?!\$)((?=\S)[^$\n]*?\S|\S)\$(?!\d)/);
      if (m) return { type: 'math_inline', raw: m[0], text: m[1] };
    },
    renderer(token) {
      return renderMath(token.text, false);
    },
  }],
});

marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code(token) {
      if (token.lang === 'mermaid') return `<div class="mermaid">${esc(token.text)}</div>`;
      if (token.lang === 'htmlrender') {
        let id = _hrContentKey.get(token.text);
        if (!id) {
          id = String(++_hrId);
          _hrContentKey.set(token.text, id);
          htmlRenderStore.set(id, token.text);
        }
        return `<div class="html-render-block" data-hrid="${id}"></div>`;
      }
      if (token.lang === 'sourcefile') {
        const [pathLine, ...annotLines] = token.text.trim().split('\n');
        const colonIdx = pathLine.lastIndexOf(':');
        const hasRanges = colonIdx > 0 && /^\d/.test(pathLine.slice(colonIdx + 1));
        const filePath = hasRanges ? pathLine.slice(0, colonIdx) : pathLine;
        const ranges = hasRanges ? pathLine.slice(colonIdx + 1) : '';
        const annotations = annotLines
          .map(l => { const m = l.match(/^@(\d+)\s+(.*)/); return m ? { line: +m[1], text: m[2] } : null; })
          .filter(Boolean);
        const escAttr = s => esc(s).replace(/"/g, '&quot;');
        const annAttr = annotations.length ? escAttr(JSON.stringify(annotations)) : '';
        return `<div class="source-file-block"` +
          ` data-path="${escAttr(filePath)}"` +
          ` data-ranges="${escAttr(ranges)}"` +
          (annAttr ? ` data-ann="${annAttr}"` : '') +
          `></div>`;
      }
      return false;
    },
  },
});

const DOMPURIFY_CONFIG = {
  ADD_TAGS: ['div'],
  ADD_ATTR: ['aria-hidden', 'data-path', 'data-ranges', 'data-ann', 'data-hrid'],
};

export function renderMd(text) {
  return DOMPurify.sanitize(marked.parse(text || ''), DOMPURIFY_CONFIG);
}
