// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { test, expect } from './fixtures.js';

test.setTimeout(90_000);

test('new session shows first user message', async ({ loggedInPage: page }) => {
  // ── Create new session & send message ───────────────────────────────────────
  await page.locator('button.new-btn[title="New session"]').click();
  await page.locator('button.new-start').click();
  await page.locator('textarea').type('hello from playwright test');
  await page.locator('button', { hasText: 'send' }).click();

  // ── Wait for user message to render ───────────────────────────────────────
  await expect(page.locator('.user-text', { hasText: 'hello from playwright test' })).toBeVisible({ timeout: 60000 });

  // ── Assert agent response also rendered ───────────────────────────────────
  await expect(page.locator('.prose').first()).toBeVisible({ timeout: 30000 });
});
