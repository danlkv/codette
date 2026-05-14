// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/** Strip console.debug(...) calls in production builds. */
function stripDebug() {
  return {
    name: 'strip-console-debug',
    apply(config, { mode }) { return mode === 'production'; },
    transform(code, id) {
      if (id.includes('node_modules') || !code.includes('console.debug')) return;
      // Remove console.debug(...) with balanced parentheses
      let result = '', i = 0;
      while (i < code.length) {
        const idx = code.indexOf('console.debug(', i);
        if (idx === -1) { result += code.slice(i); break; }
        // Check word boundary before 'console'
        if (idx > 0 && /\w/.test(code[idx - 1])) { result += code.slice(i, idx + 1); i = idx + 1; continue; }
        result += code.slice(i, idx);
        let depth = 0, j = idx + 'console.debug'.length;
        for (; j < code.length; j++) {
          if (code[j] === '(') depth++;
          else if (code[j] === ')') { depth--; if (depth === 0) { j++; break; } }
        }
        if (code[j] === ';') j++; // consume trailing semicolon
        i = j;
      }
      return result;
    },
  };
}

export default defineConfig({
  plugins: [svelte(), stripDebug()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws':   { target: 'ws://localhost:3000', ws: true },
      '/host': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
