// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

export function wtrace(src, dst, type, sessionId = null, extra = null) {
  const obj = { ts: Date.now(), src, dst, type, sessionId: sessionId?.slice(0, 8) ?? null };
  if (extra) Object.assign(obj, extra);
  console.debug('TRACE', JSON.stringify(obj));
}
