// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Strip JSONC comments (// line, /* block */) without touching comment-like
// sequences inside string values. Backslash-escape aware.

export function stripJsonComments(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      out += c; i++;
      while (i < s.length) {
        out += s[i];
        if (s[i] === '\\') { i++; out += s[i] ?? ''; i++; continue; }
        if (s[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}
