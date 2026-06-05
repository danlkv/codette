import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkTrialRateLimit, recordTrialClaim, _resetForTest } from './trial.js';

test('first claim from an IP is allowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  process.env.OAUTH_DATA_DIR = dir;
  _resetForTest();
  try {
    assert.equal(checkTrialRateLimit('1.2.3.4'), true);
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env.OAUTH_DATA_DIR;
  }
});

test('after 5 claims, 6th from same IP is blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  process.env.OAUTH_DATA_DIR = dir;
  _resetForTest();
  try {
    for (let i = 0; i < 5; i++) recordTrialClaim('5.5.5.5');
    assert.equal(checkTrialRateLimit('5.5.5.5'), false);
    assert.equal(checkTrialRateLimit('6.6.6.6'), true);
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env.OAUTH_DATA_DIR;
  }
});

test('claims older than the window expire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  process.env.OAUTH_DATA_DIR = dir;
  process.env.TRIAL_WINDOW_MS = '1';
  _resetForTest();
  try {
    recordTrialClaim('7.7.7.7');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(checkTrialRateLimit('7.7.7.7'), true);
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env.OAUTH_DATA_DIR;
    delete process.env.TRIAL_WINDOW_MS;
  }
});

