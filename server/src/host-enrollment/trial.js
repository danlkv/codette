// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Trial claim rate limiting. Tracks successful claims per IP in a sliding window.
// Persists to $CODETTE_DATA_DIR/trial-claims.json.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';

function file() {
  const dir = process.env.CODETTE_DATA_DIR || '/data/codette';
  return join(dir, 'trial-claims.json');
}

function loadAll() {
  try { return JSON.parse(readFileSync(file(), 'utf8')); } catch { return {}; }
}

function saveAll(data) {
  mkdirSync(process.env.CODETTE_DATA_DIR || '/data/codette', { recursive: true, mode: 0o700 });
  const path = file();
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

const DEFAULT_MAX = 5;
const DEFAULT_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

function maxClaims() { return parseInt(process.env.TRIAL_MAX_CLAIMS || String(DEFAULT_MAX), 10); }
function windowMs() { return parseInt(process.env.TRIAL_WINDOW_MS || String(DEFAULT_WINDOW_MS), 10); }

function pruneIp(claims, ip) {
  const cutoff = Date.now() - windowMs();
  claims[ip] = (claims[ip] || []).filter(t => t > cutoff);
  if (claims[ip].length === 0) delete claims[ip];
}

export function checkTrialRateLimit(ip) {
  const claims = loadAll();
  pruneIp(claims, ip);
  return (claims[ip] || []).length < maxClaims();
}

export function recordTrialClaim(ip) {
  const claims = loadAll();
  pruneIp(claims, ip);
  if (!claims[ip]) claims[ip] = [];
  claims[ip].push(Date.now());
  saveAll(claims);
}

// Atomic check-and-record: loads, prunes, checks the limit, and appends in one
// synchronous read-modify-write cycle. Returns true if the claim was recorded
// (allowed), false if blocked.
export function claimIfAllowed(ip) {
  const claims = loadAll();
  pruneIp(claims, ip);
  if ((claims[ip] || []).length >= maxClaims()) return false;
  if (!claims[ip]) claims[ip] = [];
  claims[ip].push(Date.now());
  saveAll(claims);
  return true;
}

// Revoke the most recent claim for an IP (roll-back on downstream failure).
export function revokeTrialClaim(ip) {
  const claims = loadAll();
  pruneIp(claims, ip);
  if (!claims[ip] || claims[ip].length === 0) return;
  claims[ip].pop();
  if (claims[ip].length === 0) delete claims[ip];
  saveAll(claims);
}

export function _resetForTest() { /* no-op — file-backed */ }
