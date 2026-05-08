// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { writable, derived } from 'svelte/store';

export const messages       = writable([]);
export const lastCost       = writable(null);
export const lastUsage          = writable(null); // { input_tokens, output_tokens, cache_read_input_tokens }
export const lastContextUsage   = writable(null); // { used: number, total: number } from modelUsage
export const hostStatus     = writable('disconnected');
export const wsOk           = writable(false);
export const highContrast   = writable(localStorage.getItem('hc') === '1');
export const vibrateOnDone  = writable(localStorage.getItem('vibrate') !== '0');
export const fontStyle      = writable(localStorage.getItem('font') || 'mono');
export const syntaxTheme    = writable(null);  // per-account; set by App.svelte
export const accentColor    = writable(null);  // per-account; set by App.svelte

// Multi-session support
export const sessions         = writable([]);    // Session[] list from server
export const currentSessionId = writable(null);  // currently displayed session id

// Derived: cwd of the currently displayed session
export const sessionCwd = derived(
  [sessions, currentSessionId],
  ([$sessions, $id]) => $sessions.find(s => s.id === $id)?.cwd ?? null
);

// Background cache: sessionId -> messages[]
// Not a Svelte store — plain mutable map, only the active session uses `messages`
export const sessionData = new Map();

export function resetStores() {
  messages.set([]);
  lastCost.set(null);
  lastUsage.set(null);
  lastContextUsage.set(null);
  hostStatus.set('disconnected');
  wsOk.set(false);
  sessions.set([]);
  currentSessionId.set(null);
}
