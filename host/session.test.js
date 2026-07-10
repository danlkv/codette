// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// createSdkSession model plumbing: options.model at start, setModel() on a
// live session (doc/protocol.spec.md agent_ctl set_model).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSdkSession, fetchSupportedModels } from './session.js';

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

test('model option is passed to SDK query options only when provided', () => {
  const { fn, calls } = fakeQuery();
  const s1 = createSdkSession({ model: 'opus', queryFn: fn });
  assert.equal(calls.options.model, 'opus');
  s1.stop();
  const s2 = createSdkSession({ queryFn: fn });
  assert.ok(!('model' in calls.options));
  s2.stop();
});

test('session.setModel delegates to the live query', async () => {
  const { fn, calls } = fakeQuery();
  const session = createSdkSession({ queryFn: fn });
  await session.setModel('haiku');
  assert.deepEqual(calls.setModel, ['haiku']);
  session.stop();
});


test('fetchSupportedModels uses a throwaway query and aborts it', async () => {
  const models = [{ value: 'claude-fable-5[1m]', displayName: 'Fable' }];
  let aborted = false;
  const fn = ({ options }) => {
    options.abortController.signal.addEventListener('abort', () => { aborted = true; });
    return {
      async *[Symbol.asyncIterator]() {},
      supportedModels() { return Promise.resolve(models); },
    };
  };
  const got = await fetchSupportedModels({ queryFn: fn });
  assert.deepEqual(got, models);
  assert.equal(aborted, true);
});
