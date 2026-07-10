// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Dispatch policy for the input bar, per doc/main.spec.md "Slash commands".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, CODETTE_COMMANDS, SDK_MAPPED } from './commands.js';

const ctx = (registry = []) => ({ registry });

// ── Dispatch order 1: codette commands ────────────────────────────────────────

test('codette view command dispatches as codette kind', () => {
  assert.deepEqual(decide('/codette-status', ctx()), {
    kind: 'codette', name: 'codette-status', arg: '',
  });
});

test('codette action command carries its argument text', () => {
  assert.deepEqual(decide('/codette-inline-files', ctx()), {
    kind: 'codette', name: 'codette-inline-files', arg: '',
  });
});

test('unknown /codette-* is passthrough (not silently swallowed)', () => {
  assert.equal(decide('/codette-nonexistent', ctx()).kind, 'passthrough');
});

// ── Dispatch order 2: SDK-mapped commands ─────────────────────────────────────

test('/model with arg maps to agent_ctl set_model when absent from registry', () => {
  assert.deepEqual(decide('/model opus', ctx(['compact', 'usage'])), {
    kind: 'agent_ctl', event: 'set_model', model: 'opus',
  });
});

test('/model passes through when present in the active registry (spawn backend)', () => {
  assert.equal(decide('/model opus', ctx(['model', 'compact'])).kind, 'passthrough');
});

test('/model without arg gives a local usage hint', () => {
  const d = decide('/model', ctx(['compact']));
  assert.equal(d.kind, 'hint');
  assert.match(d.text, /\/model </);
});

// ── Dispatch order 3: passthrough ─────────────────────────────────────────────

test('registry command is passthrough', () => {
  assert.equal(decide('/compact keep the api discussion', ctx(['compact'])).kind, 'passthrough');
});

test('unknown slash command is passthrough (Claude Code answers)', () => {
  assert.equal(decide('/nonexistent-xyz', ctx(['compact'])).kind, 'passthrough');
});

test('absolute path message is passthrough, never swallowed (regression)', () => {
  assert.equal(decide('/home/user/notes.txt what is this file', ctx()).kind, 'passthrough');
});

// ── Dispatch order 4: plain messages ──────────────────────────────────────────

test('non-slash text is a normal message', () => {
  assert.equal(decide('hello there', ctx()).kind, 'message');
});

// ── Suggestion source ─────────────────────────────────────────────────────────

test('exported command lists drive suggestions', () => {
  assert.ok(CODETTE_COMMANDS.some(c => c.cmd === '/codette-status'));
  assert.ok(SDK_MAPPED.some(c => c.cmd === '/model'));
});
