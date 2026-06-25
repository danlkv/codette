// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function freshDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'claim-limits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function freshModule() {
  // Invalidate the ESM cache so loadAll's `_migrated` resets per test.
  const url = new URL('./claim-limits.js?bust=' + Math.random(), import.meta.url);
  return import(url.pathname + url.search);
}

test('claimIfAllowed allows up to cap then blocks; per-key independence', async (t) => {
  process.env.CODETTE_DATA_DIR = freshDir(t);
  process.env.TRIAL_MAX_CLAIMS = '3';
  process.env.TRIAL_WINDOW_MS = String(60_000);
  const { claimIfAllowed } = await freshModule();

  // Three single-key claims succeed.
  assert.equal(claimIfAllowed(['idp:self:K1']), true);
  assert.equal(claimIfAllowed(['idp:self:K1']), true);
  assert.equal(claimIfAllowed(['idp:self:K1']), true);
  // Fourth blocked.
  assert.equal(claimIfAllowed(['idp:self:K1']), false);
  // A different key is unaffected.
  assert.equal(claimIfAllowed(['idp:self:K2']), true);
});

test('claimIfAllowed atomic across multiple keys — failure of one prevents writes to others', async (t) => {
  process.env.CODETTE_DATA_DIR = freshDir(t);
  process.env.TRIAL_MAX_CLAIMS = '2';
  process.env.TRIAL_WINDOW_MS = String(60_000);
  const { claimIfAllowed } = await freshModule();

  // Fill up key A to cap.
  assert.equal(claimIfAllowed(['A']), true);
  assert.equal(claimIfAllowed(['A']), true);
  // A is now at cap. A multi-key claim including A must fail AND must not touch B.
  assert.equal(claimIfAllowed(['A', 'B']), false);
  // B should still be empty — single B claim succeeds twice.
  assert.equal(claimIfAllowed(['B']), true);
  assert.equal(claimIfAllowed(['B']), true);
  assert.equal(claimIfAllowed(['B']), false);
});

test('revoke pops the most-recent timestamp', async (t) => {
  process.env.CODETTE_DATA_DIR = freshDir(t);
  process.env.TRIAL_MAX_CLAIMS = '2';
  process.env.TRIAL_WINDOW_MS = String(60_000);
  const { claimIfAllowed, revoke } = await freshModule();

  assert.equal(claimIfAllowed(['K']), true);
  assert.equal(claimIfAllowed(['K']), true);
  assert.equal(claimIfAllowed(['K']), false);   // at cap
  revoke(['K']);
  assert.equal(claimIfAllowed(['K']), true);    // slot freed
});

test('migration: legacy trial-claims.json with bare IP keys → claim-limits.json with `ip:<ip>` keys', async (t) => {
  const dir = freshDir(t);
  process.env.CODETTE_DATA_DIR = dir;
  process.env.TRIAL_MAX_CLAIMS = '5';
  process.env.TRIAL_WINDOW_MS = String(60_000);
  writeFileSync(join(dir, 'trial-claims.json'), JSON.stringify({
    '1.2.3.4': [Date.now()],
    '5.6.7.8': [Date.now(), Date.now()],
  }));

  const { claimIfAllowed } = await freshModule();
  // Trigger load (hence migration).
  claimIfAllowed(['new-key']);

  assert.equal(existsSync(join(dir, 'trial-claims.json')), false, 'legacy file unlinked');
  const migrated = JSON.parse(readFileSync(join(dir, 'claim-limits.json'), 'utf8'));
  assert.ok(migrated['ip:1.2.3.4'], 'bare IP rewritten with ip: prefix');
  assert.equal(migrated['ip:5.6.7.8'].length, 2);
});

test('migration: already-namespaced keys pass through unchanged', async (t) => {
  const dir = freshDir(t);
  process.env.CODETTE_DATA_DIR = dir;
  process.env.TRIAL_MAX_CLAIMS = '5';
  process.env.TRIAL_WINDOW_MS = String(60_000);
  writeFileSync(join(dir, 'trial-claims.json'), JSON.stringify({
    'ip:1.2.3.4':              [Date.now()],
    'idp:https://srv:KEY-abc': [Date.now()],
  }));

  const { claimIfAllowed } = await freshModule();
  claimIfAllowed(['unused']);

  const migrated = JSON.parse(readFileSync(join(dir, 'claim-limits.json'), 'utf8'));
  assert.ok(migrated['ip:1.2.3.4']);
  assert.ok(migrated['idp:https://srv:KEY-abc']);
});
