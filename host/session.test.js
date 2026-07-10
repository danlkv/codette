// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// createSdkSession model plumbing: options.model at start, setModel() on a
// live session (doc/protocol.spec.md agent_ctl set_model).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSdkSession } from './session.js';

function fakeQuery() {
  const calls = { options: null, setModel: [] };
  const fn = ({ options }) => {
    calls.options = options;
    return {
      async *[Symbol.asyncIterator]() {},           // no messages
      interrupt() {},
      setModel(m) { calls.setModel.push(m); return Promise.resolve(); },
    };
  };
  return { fn, calls };
}

test('model option is passed to the SDK query options', () => {
  const { fn, calls } = fakeQuery();
  const s = createSdkSession({ model: 'opus', queryFn: fn });
  assert.equal(calls.options.model, 'opus');
  s.stop();
});

test('no model option → model absent from SDK query options', () => {
  const { fn, calls } = fakeQuery();
  const s = createSdkSession({ queryFn: fn });
  assert.ok(!('model' in calls.options));
  s.stop();
});

test('session.setModel delegates to the live query', async () => {
  const { fn, calls } = fakeQuery();
  const session = createSdkSession({ queryFn: fn });
  await session.setModel('haiku');
  assert.deepEqual(calls.setModel, ['haiku']);
  session.stop();
});
