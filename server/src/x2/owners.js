// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Username ↔ pubkey-fingerprint binding store.
//
// Schema of $X2_DATA_DIR/username-owners.json:
// {
//   byName:   { "alice": { fp, claimedAt, idp, idp_sub } },
//   byPubkey: { "<fp>":  { username, jwk } }
// }
//
// First-to-claim wins. Both uniqueness constraints (username, pubkey) are
// checked and written atomically (single sync read-modify-write).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';

function dataDir() {
  return process.env.X2_DATA_DIR || '/data/x2';
}

function file() {
  return join(dataDir(), 'username-owners.json');
}

function load() {
  try { return JSON.parse(readFileSync(file(), 'utf8')); }
  catch { return { byName: {}, byPubkey: {} }; }
}

function save(data) {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
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

export function isPubkeyClaimed(fp) {
  return !!load().byPubkey[String(fp)];
}

export function lookupByName(name) {
  return load().byName[String(name)] || null;
}

export function lookupByPubkey(fp) {
  return load().byPubkey[String(fp)] || null;
}

/**
 * Atomically claim a (username, pubkey) binding.
 * Returns:
 *   'claimed'     — newly bound
 *   'name-taken'  — username already bound to a different pubkey
 *   'pubkey-taken'— pubkey already bound to a different username
 *   'invalid'     — username fails validation
 */
export function claimBinding(name, fp, jwk, { idp, idp_sub }) {
  if (!isValidUsername(name)) return 'invalid';
  const data = load();
  if (data.byName[name])         return 'name-taken';
  if (data.byPubkey[String(fp)]) return 'pubkey-taken';
  data.byName[name]         = { fp, claimedAt: Date.now(), idp, idp_sub };
  data.byPubkey[String(fp)] = { username: name, jwk };
  save(data);
  return 'claimed';
}
