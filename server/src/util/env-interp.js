// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Walk a parsed JSON value and substitute every `${VAR}` reference in any
// string with process.env[VAR]. Collects ALL missing variables in one pass
// and throws a single error listing them.
//
// Rules:
//   - Only ${VAR} syntax. No $VAR, no ${VAR:-default}, no nesting.
//   - Empty string in env counts as "set" (resolves to "").
//   - undefined env counts as "missing".
//   - A string may contain multiple ${VAR} substitutions; all must resolve.

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function interpolate(value, env = process.env) {
  const missing = new Set();
  const walked = walk(value, env, missing);
  if (missing.size > 0) {
    const list = [...missing].map(v => `  - ${v}`).join('\n');
    throw new Error(`Missing environment variables referenced by config:\n${list}`);
  }
  return walked;
}

function walk(v, env, missing) {
  if (typeof v === 'string') return substituteString(v, env, missing);
  if (Array.isArray(v)) return v.map(x => walk(x, env, missing));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, env, missing);
    return out;
  }
  return v;
}

function substituteString(s, env, missing) {
  return s.replace(REF, (_match, name) => {
    if (env[name] === undefined) { missing.add(name); return ''; }
    return env[name];
  });
}
