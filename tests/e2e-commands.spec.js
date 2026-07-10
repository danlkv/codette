// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Slash-command parity (doc/main.spec.md "Slash commands"):
// passthrough executes in Claude Code, output renders; codette view commands
// stay local; paths are never swallowed.

import { test, expect } from './fixtures.js';

test.setTimeout(120_000);

async function newSession(page) {
  await page.locator('button.new-btn[title="New session"]').click();
  await page.locator('button.new-start').click();
}

async function send(page, text) {
  await page.locator('textarea').fill(text);
  await page.locator('button', { hasText: 'send' }).click();
}

test('passthrough /usage executes in Claude Code and renders output', async ({ loggedInPage: page }) => {
  await newSession(page);
  // Start the session with a real message so an agent exists.
  await send(page, 'Reply with exactly: ok');
  await expect(page.locator('.prose', { hasText: 'ok' }).first()).toBeVisible({ timeout: 60000 });

  await send(page, '/usage');
  // Local command output arrives as a synthetic assistant message.
  await expect(page.locator('.prose', { hasText: /usage|subscription/i }).first()).toBeVisible({ timeout: 30000 });
});

test('codette view command is handled locally', async ({ loggedInPage: page }) => {
  await newSession(page);
  await send(page, '/codette-status');
  await expect(page.getByText(/host: .*websocket:/).first()).toBeVisible({ timeout: 10000 });
});

test('slash-prefixed path is sent as a message, not swallowed', async ({ loggedInPage: page }) => {
  await newSession(page);
  await send(page, '/tmp is a directory; reply with exactly: noted');
  // Regression for the Promise-truthiness swallow: message must render as sent.
  await expect(page.locator('.user-text', { hasText: '/tmp is a directory' })).toBeVisible({ timeout: 60000 });
});
