// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Strip JSONC comments and trailing commas, leaving valid JSON.
// String-aware (won't touch comment chars or commas inside string values),
// backslash-escape aware.

export function stripJsonComments(s) {
  return stripTrailingCommas(stripCommentsOnly(s));
}

function stripCommentsOnly(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { out += copyString(s, i); i = nextAfterString(s, i); continue; }
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

function stripTrailingCommas(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { out += copyString(s, i); i = nextAfterString(s, i); continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === ']' || s[j] === '}') { i++; continue; }   // elide trailing comma
    }
    out += c; i++;
  }
  return out;
}

// Helpers — both passes need to faithfully copy string literals.
function copyString(s, start) {
  let out = '"', i = start + 1;
  while (i < s.length) {
    const c = s[i];
    out += c;
    if (c === '\\') { i++; out += s[i] ?? ''; i++; continue; }
    if (c === '"') { return out; }
    i++;
  }
  return out;
}

function nextAfterString(s, start) {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '"') { return i + 1; }
    i++;
  }
  return i;
}
