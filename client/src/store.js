// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { writable, derived } from 'svelte/store';

export const messages       = writable([]);
export const lastCost       = writable(null);
export const lastUsage      = writable(null); // { input_tokens, output_tokens, cache_read_input_tokens }
export const hostStatus     = writable('disconnected');
export const wsOk           = writable(false);
export const highContrast   = writable(localStorage.getItem('hc') === '1');

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
  hostStatus.set('disconnected');
  wsOk.set(false);
  sessions.set([]);
  currentSessionId.set(null);
}
