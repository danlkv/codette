// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

/**
 * Shared API helpers for session file/directory access.
 * All functions throw (or return {error}) on failure — callers decide how to surface it.
 */
import { wtrace } from './trace.js';

/**
 * Fetch a file from the session.
 * Returns { content, mtime } for text files, { base64, mimeType } for binary,
 * or { error } if the server returned an application-level error.
 * Throws on network/HTTP failure.
 *
 * @param {string} sessionId
 * @param {string} path       absolute path on the server
 * @param {string} token      JWT bearer token
 * @returns {Promise<{content?:string, mtime?:number, base64?:string, mimeType?:string, error?:string}>}
 */
export async function fetchFile(sessionId, path, token) {
  wtrace('client', 'server', 'file', sessionId);
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch session history lines.
 * - No params: full history (legacy)
 * - { limit }:  last N lines (initial windowed load)
 * - { offset }: lines [offset, end) (incremental sync)
 * - { offset, limit }: lines [offset, offset+limit) (earlier batch)
 *
 * Returns { lines, totalLines, incremental }.
 * Throws on network/HTTP failure.
 *
 * @param {string} sessionId
 * @param {{ offset?: number, limit?: number }} params
 * @param {string} token
 */
export async function fetchSessions(token) {
  wtrace('client', 'server', 'list_sessions');
  const res = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createSession(token, body) {
  wtrace('client', 'server', 'new_session');
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function deleteSession(sessionId, token) {
  wtrace('client', 'server', 'delete_session', sessionId);
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
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
  return res.json();
}

/**
 * List the immediate children of a directory.
 * Returns { entries: [{name, path, isDir}] }.
 * Throws on network/HTTP failure.
 *
 * @param {string} sessionId
 * @param {string} path       absolute directory path on the server
 * @param {string} token      JWT bearer token
 * @returns {Promise<{entries: Array<{name:string, path:string, isDir:boolean}>}>}
 */
export async function listDir(sessionId, path, token) {
  wtrace('client', 'server', 'fs', sessionId);
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/fs?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();  // { entries: [{name, path, isDir}] }
}

export async function fetchGitStatus(sessionId, token) {
  wtrace('client', 'server', 'git_status', sessionId);
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/status`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchGitLog(sessionId, token) {
  wtrace('client', 'server', 'git_log', sessionId);
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/log`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchGitDiff(sessionId, commit, token) {
  wtrace('client', 'server', 'git_diff', sessionId);
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/git/diff?commit=${encodeURIComponent(commit)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchGitFileDiff(sessionId, file, token) {
  wtrace('client', 'server', 'git_file_diff', sessionId);
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/git/file-diff?path=${encodeURIComponent(file)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
