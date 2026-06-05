import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildProvider } from './provider.js';

test('only canonical /auth/success redirect URI is allowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  process.env.OAUTH_DATA_DIR = dir;
  try {
    const p = await buildProvider('http://localhost:3000');
    const c = await p.Client.find('codette-cli');
    assert.ok(c.redirectUriAllowed('http://localhost:3000/auth/success'));
    assert.ok(!c.redirectUriAllowed('http://localhost:9999/callback'));
    assert.ok(!c.redirectUriAllowed('https://evil.example.com/auth/success'));
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env.OAUTH_DATA_DIR;
  }
});

test('redirect_uri is normalized when issuer has trailing slash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  process.env.OAUTH_DATA_DIR = dir;
  try {
    const p = await buildProvider('http://localhost:3000/');
    const c = await p.Client.find('codette-cli');
    assert.ok(c.redirectUriAllowed('http://localhost:3000/auth/success'));
    assert.ok(!c.redirectUriAllowed('http://localhost:3000//auth/success'));
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env.OAUTH_DATA_DIR;
  }
});

