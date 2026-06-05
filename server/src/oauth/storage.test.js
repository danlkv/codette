import { test } from 'node:test';
import assert from 'node:assert';
import { FileAdapter } from './storage.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test('upsert + find round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  process.env.OAUTH_DATA_DIR = dir;
  try {
    const a = new FileAdapter('AccessToken');
    await a.upsert('id1', { sub: 'u1', grantId: 'g1' }, 60);
    const found = await a.find('id1');
    assert.equal(found.sub, 'u1');
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env.OAUTH_DATA_DIR;
  }
});

test('revokeByGrantId removes all entries for grantId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  process.env.OAUTH_DATA_DIR = dir;
  try {
    const a = new FileAdapter('AccessToken');
    await a.upsert('id1', { sub: 'u1', grantId: 'g1' }, 60);
    await a.upsert('id2', { sub: 'u2', grantId: 'g1' }, 60);
    await a.upsert('id3', { sub: 'u3', grantId: 'g2' }, 60);
    await a.revokeByGrantId('g1');
    assert.equal(await a.find('id1'), undefined);
    assert.equal(await a.find('id2'), undefined);
    assert.ok(await a.find('id3'));
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env.OAUTH_DATA_DIR;
  }
});
