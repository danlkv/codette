// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { writable, derived } from 'svelte/store';
import { getSettings } from './utils/storage.js';

export const messages       = writable([]);
export const lastCost       = writable(null);
export const lastUsage          = writable(null); // { input_tokens, output_tokens, cache_read_input_tokens }
export const lastContextUsage   = writable(null); // { used: number, total: number } from modelUsage
export const hostStatus     = writable('disconnected');
export const slashRegistry  = writable([]); // active backend's init.slash_commands
export const modelRegistry  = writable([]); // host-fetched ModelInfo list
export const wsOk           = writable(false);
export const colorScheme    = writable(getSettings('colorScheme'));
export const highContrast   = writable(getSettings('highContrast'));
export const vibrateOnDone  = writable(getSettings('vibrate'));
export const fontStyle      = writable(getSettings('font'));
export const syntaxTheme          = writable(null);  // per-account; set by App.svelte
export const effectiveSyntaxTheme = writable(null);  // resolved shiki theme id (family → dark/light variant)
export const accentColor          = writable(null);  // per-account; set by App.svelte
export const showFileChips  = writable(getSettings('showFileChips'));

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
