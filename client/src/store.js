// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { writable } from 'svelte/store';

export const messages     = writable([]);
export const lastCost     = writable(null);
export const hostStatus   = writable('disconnected');
export const wsOk         = writable(false);
export const highContrast = writable(localStorage.getItem('hc') === '1');
