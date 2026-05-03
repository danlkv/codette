// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { marked } from 'marked';
import DOMPurify from 'dompurify';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code(token) {
      if (token.lang === 'mermaid') return `<div class="mermaid">${esc(token.text)}</div>`;
      return false;
    },
  },
});

export function renderMd(text) {
  return DOMPurify.sanitize(marked.parse(text || ''), { ADD_TAGS: ['div'] });
}
