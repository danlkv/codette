// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.use({ breaks: true, gfm: true });

export function renderMd(text) {
  return DOMPurify.sanitize(marked.parse(text || ''));
}
