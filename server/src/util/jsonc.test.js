// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripJsonComments } from './jsonc.js';

test('strips // line comments', () => {
  const s = `{
    "a": 1, // trailing
    // standalone
    "b": 2
  }`;
  assert.deepEqual(JSON.parse(stripJsonComments(s)), { a: 1, b: 2 });
});

test('strips /* block */ comments', () => {
  const s = `{
    /* leading */ "a": 1,
    "b": /* inline */ 2,
    /* multi
       line */ "c": 3
  }`;
  assert.deepEqual(JSON.parse(stripJsonComments(s)), { a: 1, b: 2, c: 3 });
});

test('preserves // inside string values (URLs etc.)', () => {
  const s = `{ "url": "http://example.com/path", "x": 1 }`;
  assert.deepEqual(JSON.parse(stripJsonComments(s)), { url: 'http://example.com/path', x: 1 });
});

test('preserves /* */ inside string values', () => {
  const s = `{ "pattern": "/* matches */", "x": 1 }`;
  assert.deepEqual(JSON.parse(stripJsonComments(s)), { pattern: '/* matches */', x: 1 });
});

test('respects backslash escapes in strings', () => {
  const s = `{ "q": "say \\"hi\\" //not comment", "x": 1 }`;
  assert.deepEqual(JSON.parse(stripJsonComments(s)), { q: 'say "hi" //not comment', x: 1 });
});

test('elides trailing comma before closing array', () => {
  const s = `{ "a": [1, 2, 3,] }`;
  assert.deepEqual(JSON.parse(stripJsonComments(s)), { a: [1, 2, 3] });
});

test('elides trailing comma before closing object', () => {
  const s = `{ "a": 1, "b": 2, }`;
  assert.deepEqual(JSON.parse(stripJsonComments(s)), { a: 1, b: 2 });
});

test('elides trailing comma left after stripping commented-out array items', () => {
  const s = `{ "providers": [
    {"a": 1},   // first
    // {"b": 2},   <-- the only entry was this and it's commented out
  ] }`;
  assert.deepEqual(JSON.parse(stripJsonComments(s)), { providers: [{ a: 1 }] });
});

test('preserves "," inside string values', () => {
  const s = `{ "csv": "a,b,c", "trailing": "x,]" }`;
  assert.deepEqual(JSON.parse(stripJsonComments(s)), { csv: 'a,b,c', trailing: 'x,]' });
});
