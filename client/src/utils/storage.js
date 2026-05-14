// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { summarizeOldLines, KEEP as SUMMARIZE_KEEP } from '../lib/summarize.js';

// ── Schema version ───────────────────────────────────────────────────────────
const STORAGE_VERSION = 1;
const VERSION_KEY = 'codette_storage_v';

(function checkVersion() {
  const v = localStorage.getItem(VERSION_KEY);
  if (v === null) { localStorage.setItem(VERSION_KEY, String(STORAGE_VERSION)); return; }
  const cur = Number(v);
  if (cur < STORAGE_VERSION) {
    // Future migrations go here: if (cur < 2) { ... }
    localStorage.setItem(VERSION_KEY, String(STORAGE_VERSION));
  }
})();

// ── Settings ──────────────────────────────────────────────────────────────────
// Key map: public name → localStorage key (+ default value)
const SETTINGS = {
  colorScheme:  { key: 'colorScheme',              fallback: 'system' },
  highContrast: { key: 'hc',                       fallback: false,  encode: v => v ? '1' : '0',    decode: v => v === '1' },
  vibrate:      { key: 'vibrate',                   fallback: true,   encode: v => v ? '1' : '0',    decode: v => v !== '0' },
  font:         { key: 'font',                      fallback: 'mono' },
  showFileChips:{ key: 'claudeweb_showFileChips',   fallback: true,   encode: v => v ? 'true':'false', decode: v => v !== 'false' },
  inlineFiles:  { key: 'claudeweb_inlineFiles',     fallback: true,   encode: v => v ? 'true':'false', decode: v => v !== 'false' },
  sidebarOpen:  { key: 'claudeweb_sidebarOpen',     fallback: true,   encode: v => v ? 'true':'false', decode: v => v !== 'false' },
  gitChanges:   { key: 'claudeweb_gitChanges',      fallback: false,  encode: v => v ? 'true':'false', decode: v => v === 'true' },
  gitLog:       { key: 'claudeweb_gitLog',           fallback: false,  encode: v => v ? 'true':'false', decode: v => v === 'true' },
  fileExplorer: { key: 'claudeweb_fileExplorer',     fallback: true,   encode: v => v ? 'true':'false', decode: v => v !== 'false' },
};

export function getSettings(name) {
  if (name) {
    const s = SETTINGS[name];
    if (!s) return undefined;
    const raw = localStorage.getItem(s.key);
    if (raw === null) return s.fallback;
    return s.decode ? s.decode(raw) : raw;
  }
  const all = {};
  for (const [k, s] of Object.entries(SETTINGS)) {
    const raw = localStorage.getItem(s.key);
    all[k] = raw === null ? s.fallback : (s.decode ? s.decode(raw) : raw);
  }
  return all;
}

export function saveSettings(name, value) {
  const s = SETTINGS[name];
  if (!s) return;
  localStorage.setItem(s.key, s.encode ? s.encode(value) : value);
}

// ── Accounts ──────────────────────────────────────────────────────────────────
export function getAccounts() {
  let accounts = [];
  try {
    accounts = JSON.parse(localStorage.getItem('chat_accounts') || '[]');
  } catch { accounts = []; }
  const active = localStorage.getItem('chat_active_user') || null;
  return { accounts, active };
}

export function saveAccounts(accounts, activeUsername) {
  localStorage.setItem('chat_accounts', JSON.stringify(accounts));
  if (activeUsername != null) {
    localStorage.setItem('chat_active_user', activeUsername);
  }
}

// ── E2E key store (IndexedDB) ─────────────────────────────────────────────────
// Non-extractable CryptoKeys survive structured clone, so IndexedDB can store
// them without exposing raw key material to JS.

const IDB_NAME = 'codette_e2e';
const IDB_STORE = 'keys';

function openKeyDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store { encKey, nonceKey } pair for a username. */
export async function storeEncKeys(username, encKey, nonceKey) {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ encKey, nonceKey }, username);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load { encKey, nonceKey } for a username. Returns null if missing or v1 format. */
export async function loadEncKeys(username) {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(username);
    req.onsuccess = () => {
      const val = req.result;
      if (val?.encKey && val?.nonceKey) return resolve(val);
      resolve(null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteEncKey(username) {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(username);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── History cache ─────────────────────────────────────────────────────────────
const HISTORY_PREFIX = 'history_';

export function getHistory(sessionId) {
  try {
    const raw = localStorage.getItem(HISTORY_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!('lineCount' in parsed)) return null;
    return parsed;
  } catch { return null; }
}

export function removeHistory(sessionId) {
  localStorage.removeItem(HISTORY_PREFIX + sessionId);
}

export function hasHistory(sessionId) {
  return localStorage.getItem(HISTORY_PREFIX + sessionId) !== null;
}

function evictOldestHistory(skipSessionId, n = 2) {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(HISTORY_PREFIX) || k === HISTORY_PREFIX + skipSessionId) continue;
    try {
      const ts = JSON.parse(localStorage.getItem(k))?.ts ?? 0;
      entries.push({ k, ts });
    } catch { entries.push({ k, ts: 0 }); }
  }
  entries.sort((a, b) => a.ts - b.ts);
  const toEvict = entries.slice(0, n);
  for (const { k } of toEvict) localStorage.removeItem(k);
  return toEvict.length;
}

const byteEst = s => new Blob([s]).size;

export function saveHistory(sessionId, { lines, lineCount, title = '', contextWindow = null }) {
  const ts = Date.now();
  const raw = JSON.stringify({ lines, lineCount, ts, title, ...(contextWindow && { contextWindow }) });
  const result = { stored: false, summarized: false, evicted: 0, lines: lines.length, bytes: byteEst(raw) };

  // 1. try raw
  try {
    localStorage.setItem(HISTORY_PREFIX + sessionId, raw);
    result.stored = true;
    return result;
  } catch (e) {
    if (e.name !== 'QuotaExceededError') return result;
  }

  // 2. summarize and retry
  const summarized = lines.length > SUMMARIZE_KEEP
    ? [...summarizeOldLines(lines.slice(0, -SUMMARIZE_KEEP)), ...lines.slice(-SUMMARIZE_KEEP)]
    : summarizeOldLines(lines);
  const sumRaw = JSON.stringify({ lines: summarized, lineCount, ts, title });
  result.summarized = true;
  result.lines = summarized.length;
  result.bytes = byteEst(sumRaw);

  try {
    localStorage.setItem(HISTORY_PREFIX + sessionId, sumRaw);
    result.stored = true;
    return result;
  } catch (e) {
    if (e.name !== 'QuotaExceededError') return result;
  }

  // 3. evict oldest and retry
  result.evicted = evictOldestHistory(sessionId, 2);
  if (result.evicted === 0) return result;

  try {
    localStorage.setItem(HISTORY_PREFIX + sessionId, sumRaw);
    result.stored = true;
  } catch {}
  return result;
}
