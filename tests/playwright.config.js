// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { defineConfig } from '@playwright/test';

const TEST_PORT = process.env.TEST_PORT || '3111';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${TEST_PORT}`,
    trace: 'on',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: `TEST_PORT=${TEST_PORT} node start-test-env.js`,
    port: parseInt(TEST_PORT),
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
