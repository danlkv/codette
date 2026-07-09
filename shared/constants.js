// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

export const APP_NAME = 'codette';

// WS close code sent to a /host connection evicted by a newer connection
// presenting a valid handshake proof for the same key (4000-4999 = app range).
// The evicted host must NOT auto-reconnect on this code.
export const WS_CLOSE_TAKEN_OVER = 4001;
export const WS_TAKEN_OVER_REASON = 'taken over by another host connection';
