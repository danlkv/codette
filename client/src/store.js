// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { writable } from 'svelte/store';

export const messages       = writable([]);
export const lastCost       = writable(null);
export const lastUsage      = writable(null); // { input_tokens, output_tokens, cache_read_input_tokens }
export const hostStatus     = writable('disconnected');
export const wsOk           = writable(false);
export const highContrast   = writable(localStorage.getItem('hc') === '1');

// Multi-session support
export const sessions         = writable([]);    // Session[] list from server
export const currentSessionId = writable(null);  // currently displayed session id

// Background cache: sessionId -> messages[]
// Not a Svelte store — plain mutable map, only the active session uses `messages`
export const sessionData = new Map();
