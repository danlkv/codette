// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { test as base, expect } from '@playwright/test';
import { writeFileSync } from 'fs';

export const USERNAME = process.env.TEST_USERNAME || 'testuser';
export const PASSWORD = process.env.TEST_PASSWORD || 'testpass';

/**
 * Extended test fixture that provides a logged-in page and console log capture.
 */
export const test = base.extend({
  /** Logs in before each test and provides the authenticated page. */
  loggedInPage: async ({ page }, use) => {
    // Console capture
    const consoleLogs = [];
    page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => consoleLogs.push(`[pageerror] ${err.message}`));
    page.consoleLogs = consoleLogs;
    page.flushLogs = (path) => writeFileSync(path, consoleLogs.join('\n'));

    // Login
    await page.goto('/');
    await page.locator('input[autocomplete="username"]').fill(USERNAME);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('button.new-btn[title="New session"]')).toBeVisible({ timeout: 15000 });

    await use(page);
  },
});

export { expect };
