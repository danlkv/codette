// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Inline math $...$ must follow pandoc boundary rules so currency
// amounts in prose are not typeset as formulas.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './markdown.js'; // side effect: registers math extensions on marked
import { marked } from 'marked';

const hasMath = s => marked.parse(s).includes('class="katex"');

test('two dollar amounts in prose are not math', () => {
  assert.equal(hasMath('costs $2 and $3 more'), false);
});

test('currency range without spaces is not math', () => {
  assert.equal(hasMath('range $2k–$3k'), false);
});

test('inline math renders', () => {
  assert.equal(hasMath('sum $x+y$ here'), true);
});

test('math starting with a digit renders', () => {
  assert.equal(hasMath('grows as $2^n$'), true);
});
