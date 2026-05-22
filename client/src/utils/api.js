// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

/**
 * Shared API helpers for session file/directory access.
 * All functions throw (or return {error}) on failure — callers decide how to surface it.
 */
import { wtrace } from './trace.js';
import { encrypt, encryptDet, packParam, decrypt } from './crypto.js';

// ── E2E key state (set by App.svelte effect) ─────────────────────────────────
let _encKey = null, _nonceKey = null;

export function setE2EKeys(encKey, nonceKey) {
  _encKey = encKey;
  _nonceKey = nonceKey;
}

export function clearE2EKeys() {
  _encKey = null;
  _nonceKey = null;
}

/** Decrypt response JSON if it contains encrypted payload.
 *  Rejects plaintext when keys exist (downgrade protection). */
async function decryptResponse(json) {
  if (_encKey && json.nonce && json.ciphertext) {
    const decrypted = JSON.parse(await decrypt(_encKey, json.nonce, json.ciphertext));
    if (decrypted.error) throw new Error(decrypted.error);
    return decrypted;
  }
  if (_encKey) throw new Error('e2e: expected encrypted response but got plaintext');
  return json;
}

/** Build enc_path query param from a file/dir path (deterministic nonce). */
async function buildEncPath(path) {
  if (!_encKey || !_nonceKey) return null;
  const { nonce, ciphertext } = await encryptDet(_encKey, _nonceKey, 'path:' + path, JSON.stringify({ path }));
  return packParam(nonce, ciphertext);
}

/**
 * Fetch a file from the session.
 * Returns { content, mtime } for text files, { base64, mimeType } for binary,
 * or { error } if the server returned an application-level error.
 * Throws on network/HTTP failure.
 */
export async function fetchFile(sessionId, path, token) {
  wtrace('client', 'server', 'file', sessionId);
  const enc = await buildEncPath(path);
  const url = enc
    ? `/api/sessions/${encodeURIComponent(sessionId)}/file?enc_path=${encodeURIComponent(enc)}`
    : `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decryptResponse(await res.json());
}

/**
 * Fetch session history lines.
 * Returns { lines, totalLines, incremental }.
 * Throws on network/HTTP failure.
 */
export async function fetchSessions(token) {
  wtrace('client', 'server', 'list_sessions');
  const res = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decryptResponse(await res.json());
}

export async function deleteSession(sessionId, token) {
  wtrace('client', 'server', 'delete_session', sessionId);
  // Encrypt '{}' under e2e — host requires nonce+ciphertext on this type, and
  // decrypts to a valid (empty) JSON object before merging.
  let url = `/api/sessions/${encodeURIComponent(sessionId)}`;
  if (_encKey) {
    const { nonce, ciphertext } = await encrypt(_encKey, '{}');
    url += `?enc=${encodeURIComponent(packParam(nonce, ciphertext))}`;
  }
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function setSessionName(sessionId, name, token) {
  wtrace('client', 'server', 'set_session_name', sessionId);
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/name`;
  let body;
  if (_encKey) {
    const { nonce, ciphertext } = await encrypt(_encKey, JSON.stringify({ name: name || null }));
    body = JSON.stringify({ enc: packParam(nonce, ciphertext) });
  } else {
    body = JSON.stringify({ name: name || null });
  }
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function fetchHistory(sessionId, { offset = null, limit = null } = {}, token) {
  wtrace('client', 'server', 'history', sessionId);
  const p = new URLSearchParams();
  if (offset != null) p.set('offset', offset);
  if (limit  != null) p.set('limit',  limit);
  const qs = p.size ? '?' + p : '';
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/history${qs}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // Under e2e, response is { nonce, ciphertext, incremental }; decrypt inner, keep metadata.
  if (_encKey && json.nonce && json.ciphertext) {
    const { incremental } = json;
    const decrypted = JSON.parse(await decrypt(_encKey, json.nonce, json.ciphertext));
    if (decrypted.error) throw new Error(decrypted.error);
    return { ...decrypted, incremental };
  }
  if (_encKey) throw new Error('e2e: expected encrypted response but got plaintext');
  return json;
}

/**
 * List the immediate children of a directory.
 * Returns { entries: [{name, path, isDir}] }.
 */
export async function listDir(sessionId, path, token) {
  wtrace('client', 'server', 'fs', sessionId);
  const enc = await buildEncPath(path);
  const url = enc
    ? `/api/sessions/${encodeURIComponent(sessionId)}/fs?enc_path=${encodeURIComponent(enc)}`
    : `/api/sessions/${encodeURIComponent(sessionId)}/fs?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return decryptResponse(await res.json());
}

export async function fetchGitStatus(sessionId, token) {
  wtrace('client', 'server', 'git_status', sessionId);
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/status`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decryptResponse(await res.json());
}

export async function fetchGitLog(sessionId, token) {
  wtrace('client', 'server', 'git_log', sessionId);
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/log`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decryptResponse(await res.json());
}

export async function fetchGitDiff(sessionId, commit, token) {
  wtrace('client', 'server', 'git_diff', sessionId);
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/git/diff?commit=${encodeURIComponent(commit)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decryptResponse(await res.json());
}

export async function fetchGitFileDiff(sessionId, file, token) {
  wtrace('client', 'server', 'git_file_diff', sessionId);
  const enc = await buildEncPath(file);
  const url = enc
    ? `/api/sessions/${encodeURIComponent(sessionId)}/git/file-diff?enc_path=${encodeURIComponent(enc)}`
    : `/api/sessions/${encodeURIComponent(sessionId)}/git/file-diff?path=${encodeURIComponent(file)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decryptResponse(await res.json());
}
