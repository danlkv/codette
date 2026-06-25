// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Sliding-window claim ledger. Keys are arbitrary strings; callers pick
// what they mean (e.g. `ip:1.2.3.4`, `idp:<iss>:<sub>`). Persists to
// $CODETTE_DATA_DIR/claim-limits.json.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

function dataDir() {
  return process.env.CODETTE_DATA_DIR || '/data/codette';
}

function file() {
  return join(dataDir(), 'claim-limits.json');
}

function legacyFile() {
  return join(dataDir(), 'trial-claims.json');
}

let _migrated = false;
function migrateLegacyOnce() {
  if (_migrated) return;
  _migrated = true;
  if (existsSync(file()) || !existsSync(legacyFile())) return;
  let legacy;
  try { legacy = JSON.parse(readFileSync(legacyFile(), 'utf8')); } catch { return; }
  const next = {};
  for (const [k, v] of Object.entries(legacy)) {
    // Old keys were bare IPs; rewrite to `ip:<ip>`. Anything already namespaced is passed through.
    const newKey = k.includes(':') ? k : `ip:${k}`;
    next[newKey] = v;
  }
  saveAll(next);
  try { unlinkSync(legacyFile()); } catch {}
}

function loadAll() {
  migrateLegacyOnce();
  try { return JSON.parse(readFileSync(file(), 'utf8')); } catch { return {}; }
}

function saveAll(data) {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const path = file();
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

const DEFAULT_MAX = 5;
const DEFAULT_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

function maxClaims() { return parseInt(process.env.TRIAL_MAX_CLAIMS || String(DEFAULT_MAX), 10); }
function windowMs() { return parseInt(process.env.TRIAL_WINDOW_MS || String(DEFAULT_WINDOW_MS), 10); }

function pruneKey(claims, key) {
  const cutoff = Date.now() - windowMs();
  claims[key] = (claims[key] || []).filter(t => t > cutoff);
  if (claims[key].length === 0) delete claims[key];
}

/**
 * @param {string[]} keys
 * @returns true if every key was under the cap; in that case `now` is appended
 *          to each and persisted. false if any key was at the cap (no writes).
 */
export function claimIfAllowed(keys) {
  const claims = loadAll();
  const max = maxClaims();
  for (const k of keys) {
    pruneKey(claims, k);
    if ((claims[k] || []).length >= max) return false;
  }
  const now = Date.now();
  for (const k of keys) {
    if (!claims[k]) claims[k] = [];
    claims[k].push(now);
  }
  saveAll(claims);
  return true;
}

/**
 * Pop the most recent timestamp from each key (rollback on downstream failure).
 * @param {string[]} keys
 */
export function revoke(keys) {
  if (!keys || keys.length === 0) return;
  const claims = loadAll();
  let changed = false;
  for (const k of keys) {
    pruneKey(claims, k);
    if (claims[k] && claims[k].length > 0) {
      claims[k].pop();
      if (claims[k].length === 0) delete claims[k];
      changed = true;
    }
  }
  if (changed) saveAll(claims);
}

export function _resetMigrationFlagForTest() { _migrated = false; }
