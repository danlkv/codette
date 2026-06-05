// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Username ↔ OAuth-sub binding. The host CLI prompts for a username locally
// (host's authority). At consent time the server records {username → sub,
// sub → username} so subsequent /host WS connections can verify that the
// token-bearer's claimed clientUsername matches the binding (squatting fix).
//
// First-to-claim wins; once a (username, sub) pair is recorded the username
// is locked to that sub even after the token expires. Re-using the same sub
// is idempotent ('reclaimed').

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';

function file() {
  const dir = process.env.OAUTH_DATA_DIR || '/data/oauth';
  return join(dir, 'username-owners.json');
}

function load() {
  try { return JSON.parse(readFileSync(file(), 'utf8')); }
  catch { return { byName: {}, bySub: {} }; }
}

function save(data) {
  mkdirSync(process.env.OAUTH_DATA_DIR || '/data/oauth', { recursive: true, mode: 0o700 });
  const path = file();
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

const NAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;

export function isValidUsername(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

export function isUsernameClaimed(name) {
  if (!isValidUsername(name)) return false;
  return !!load().byName[name];
}

export function lookupUsernameBySub(sub) {
  return load().bySub[sub] || null;
}

export function lookupOwnerByUsername(name) {
  return load().byName[name] || null;
}

// Atomic claim. Returns 'claimed' (newly bound), 'reclaimed' (already bound
// to this sub — idempotent), or 'taken' (owned by a different sub).
export function claimUsername(name, sub) {
  if (!isValidUsername(name)) return 'invalid';
  const data = load();
  const existing = data.byName[name];
  if (existing && existing.sub === sub) return 'reclaimed';
  if (existing) return 'taken';
  data.byName[name] = { sub, claimedAt: Date.now() };
  data.bySub[sub] = name;
  save(data);
  return 'claimed';
}
