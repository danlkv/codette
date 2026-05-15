// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { test, expect } from './fixtures.js';

test('login and see session list', async ({ loggedInPage: page }) => {
  // If we got here, login succeeded (fixture waits for "New session" button).
  await expect(page.locator('button.new-btn[title="New session"]')).toBeVisible();
});
