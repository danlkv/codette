import { test } from 'node:test';
import assert from 'node:assert';
import { makeValidateHostToken } from './host-auth.js';

function mockProvider(tokenLookups) {
  return {
    AccessToken: {
      find: async (t) => tokenLookups[t],
    },
  };
}

test('returns null for missing token', async () => {
  const v = makeValidateHostToken(mockProvider({}));
  assert.equal(await v(''), null);
  assert.equal(await v(null), null);
  assert.equal(await v(undefined), null);
});

test('returns null for unknown token', async () => {
  const v = makeValidateHostToken(mockProvider({}));
  assert.equal(await v('bogus'), null);
});

test('returns null for expired token', async () => {
  const v = makeValidateHostToken(mockProvider({
    'exp-tok': { accountId: 'u1', isExpired: true },
  }));
  assert.equal(await v('exp-tok'), null);
});

test('returns sub for valid token', async () => {
  const v = makeValidateHostToken(mockProvider({
    'valid-tok': { accountId: 'user-abc', isExpired: false },
  }));
  assert.deepEqual(await v('valid-tok'), { sub: 'user-abc' });
});

test('returns null on adapter throw', async () => {
  const v = makeValidateHostToken({
    AccessToken: { find: async () => { throw new Error('boom'); } },
  });
  assert.equal(await v('any'), null);
});
