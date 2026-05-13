// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

export function wtrace(src, dst, type, sessionId = null) {
  console.log('TRACE', JSON.stringify({ ts: Date.now(), src, dst, type, sessionId: sessionId?.slice(0, 8) ?? null }));
}
