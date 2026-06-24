// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Shared HTML rendering utilities used by host-enrollment and user-auth.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ERROR_HTML = readFileSync(path.join(__dirname, '../host-enrollment/views/error.html'), 'utf8');

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export function renderError(res, { title, message, hint }) {
  return res.status(400).type('html').send(
    ERROR_HTML
      .replace('__TITLE__', escapeHtml(title || 'Error'))
      .replace('__MESSAGE__', escapeHtml(message || ''))
      .replace('__HINT__', hint || '')
  );
}
