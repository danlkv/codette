// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate } from './env-interp.js';

test('substitutes ${VAR} in string values', () => {
  const out = interpolate({ a: 'hello ${WHO}' }, { WHO: 'world' });
  assert.deepEqual(out, { a: 'hello world' });
});

test('walks arrays and nested objects', () => {
  const out = interpolate(
    { providers: [{ id: '${A}', secret: '${B}' }] },
    { A: 'alpha', B: 'beta' },
  );
  assert.deepEqual(out, { providers: [{ id: 'alpha', secret: 'beta' }] });
});

test('multiple substitutions in one string', () => {
  const out = interpolate({ url: '${HOST}:${PORT}' }, { HOST: 'localhost', PORT: '3000' });
  assert.deepEqual(out, { url: 'localhost:3000' });
});

test('empty string in env counts as set', () => {
  const out = interpolate({ x: '${E}' }, { E: '' });
  assert.deepEqual(out, { x: '' });
});

test('missing variable throws with the variable name', () => {
  assert.throws(
    () => interpolate({ x: '${MISSING}' }, {}),
    err => /Missing environment variables/.test(err.message) && /MISSING/.test(err.message),
  );
});

test('multiple missing variables are reported together in one error', () => {
  let err;
  try { interpolate({ a: '${X}', b: '${Y}', c: '${X}' }, {}); }
  catch (e) { err = e; }
  assert.ok(err, 'should throw');
  assert.match(err.message, /X/);
  assert.match(err.message, /Y/);
  // Same var referenced twice is listed once.
  assert.equal((err.message.match(/X/g) || []).length, 1);
});

test('non-string values pass through', () => {
  const out = interpolate({ n: 42, b: true, arr: [1, 2], obj: { x: null } }, {});
  assert.deepEqual(out, { n: 42, b: true, arr: [1, 2], obj: { x: null } });
});

test('only ${VAR} syntax — bare $VAR is literal', () => {
  const out = interpolate({ x: '$NOTAVAR and ${SET}' }, { SET: 'ok' });
  assert.deepEqual(out, { x: '$NOTAVAR and ok' });
});
