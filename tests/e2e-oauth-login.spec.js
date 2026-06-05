// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// E2E: simulate `codette login` (PKCE + localhost callback) by driving a browser
// through /oauth/auth and confirming the CLI's local listener receives the code.

import { test, expect } from '@playwright/test';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { b64url, generatePKCE } from './oauth-flow.js';

const TEST_PORT = process.env.TEST_PORT || '3111';
const SERVER_BASE = `http://localhost:${TEST_PORT}`;

test('OAuth trial flow: browser click → access_token in callback', async ({ page }) => {
  // Unique username per run — server-side binding records persist across the
  // test suite's lifetime (within the per-run OAUTH_DATA_DIR isolation in
  // start-test-env.js), so we can't reuse a name.
  const username = 'e2e-' + randomBytes(4).toString('hex');

  // Start a localhost listener (the "CLI" in this test)
  const cliPort = 39000 + Math.floor(Math.random() * 1000);
  const codePromise = new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${cliPort}`);
      if (u.pathname === '/callback') {
        res.writeHead(200, { 'access-control-allow-origin': '*' }).end('ok');
        srv.close();
        resolve(u.searchParams.get('code'));
      } else { res.writeHead(404).end(); }
    });
    srv.listen(cliPort, '127.0.0.1');
  });

  // PKCE
  const { verifier, challenge } = generatePKCE();
  const state = b64url(JSON.stringify({ port: cliPort, nonce: '0123456789abcdef' }));
  const redirectUri = `${SERVER_BASE}/auth/success`;

  const authUrl = `${SERVER_BASE}/oauth/auth?` + new URLSearchParams({
    response_type: 'code',
    client_id: 'codette-cli',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'openid offline_access',
    prompt: 'consent',
    login_hint: username,
  });

  await page.goto(authUrl);
  await expect(page.locator('.brand', { hasText: 'codette' })).toBeVisible();
  await expect(page.locator('.uname', { hasText: username })).toBeVisible();
  await page.locator('button', { hasText: /without registration/ }).click();

  // After click: browser lands on /auth/success which JS-fetches the localhost callback
  await expect(page.locator('.brand', { hasText: 'codette' })).toBeVisible();

  // Localhost listener should receive the code
  const code = await Promise.race([
    codePromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('listener timeout')), 10_000)),
  ]);
  expect(code).toBeTruthy();

  // Exchange code for tokens
  const tokenRes = await fetch(`${SERVER_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: 'codette-cli',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  expect(tokenRes.ok).toBe(true);
  const tokens = await tokenRes.json();
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
});
