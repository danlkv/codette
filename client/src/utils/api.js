// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

/**
 * Shared API helpers for session file/directory access.
 * All functions throw (or return {error}) on failure — callers decide how to surface it.
 */

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
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/fs?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();  // { entries: [{name, path, isDir}] }
}
