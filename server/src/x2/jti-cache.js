// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// In-memory JTI dedup cache with TTL eviction.
// Keyed by jti string; value is exp epoch (seconds).
// Has() evicts expired entries on lookup.

export function makeJtiCache() {
  const map = new Map(); // jti → exp (seconds)

  function has(jti) {
    if (!map.has(jti)) return false;
    const exp = map.get(jti);
    if (Math.floor(Date.now() / 1000) > exp) {
      map.delete(jti);
      return false;
    }
    return true;
  }

  function mark(jti, exp) {
    map.set(jti, exp);
  }

  // Periodic eviction sweep (every 5 min) to bound memory usage.
  const timer = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of map) {
      if (now > exp) map.delete(jti);
    }
  }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();

  return { has, mark };
}
