// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws':   { target: 'ws://localhost:3000', ws: true },
      '/host': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
