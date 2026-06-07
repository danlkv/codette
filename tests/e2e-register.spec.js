// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// E2E: X2 registration flow
//   1. Generate an ES256 keypair + sign host_proof
//   2. page.goto /register/start → expect consent page
//   3. Click "Try without registration" → expect done page
//   4. fetch /register/status → expect {status: 'claimed'}
//   5. Open WS to /host with a fresh signed handshake → expect it to upgrade

import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import { generateTestKeypair } from './oauth-flow.js';
import { signHandshakeProof } from '../host/auth.js';
import { _resetKeyCache } from '../host/auth.js';
import { SignJWT } from 'jose';

const TEST_PORT = process.env.TEST_PORT || '3111';
const SERVER_BASE = `http://localhost:${TEST_PORT}`;
const SERVER_WS   = `ws://localhost:${TEST_PORT}`;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('X2 registration: browser consent click → /register/status claimed', async ({ page }) => {
  const username = 'e2e-' + randomBytes(4).toString('hex');
  const state = b64url(randomBytes(16));

  const { jwk, jkt, privateKeyJose } = await generateTestKeypair();

  // Sign host_proof
  const hostProof = await new SignJWT({ username })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(jkt)
    .setAudience(`${SERVER_BASE}/register`)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJwtId(randomBytes(16).toString('hex'))
    .sign(privateKeyJose);

  const jwkB64 = b64url(Buffer.from(JSON.stringify(jwk)));
  const startUrl = `${SERVER_BASE}/register/start?` + new URLSearchParams({
    state, username, jwk: jwkB64, host_proof: hostProof, idp: 'trial',
  });

  // Navigate to consent page
  await page.goto(startUrl);
  await expect(page.locator('.brand', { hasText: 'codette' })).toBeVisible();
  await expect(page.locator('.uname', { hasText: username })).toBeVisible();

  // Click the consent button
  await page.locator('button', { hasText: /without registration/ }).click();

  // Should land on done page
  await expect(page.locator('.brand', { hasText: 'codette' })).toBeVisible();
  await expect(page.locator('.ok')).toBeVisible();

  // Poll status
  let status = null;
  for (let i = 0; i < 20; i++) {
    const res = await page.request.get(`${SERVER_BASE}/register/status?state=${encodeURIComponent(state)}`);
    const body = await res.json();
    status = body.status;
    if (status === 'claimed') break;
    await page.waitForTimeout(300);
  }
  expect(status).toBe('claimed');
});

test('X2 WS handshake: registered host can connect via signed proof', async () => {
  const username = 'ws-' + randomBytes(4).toString('hex');
  const state = b64url(randomBytes(16));

  const { keyFilePath, jwk, jkt, privateKeyJose, dir } = await generateTestKeypair();

  // Sign host_proof and register via headless helper
  const { headlessRegister } = await import('./oauth-flow.js');
  await headlessRegister({ serverBase: SERVER_BASE, username, keyFilePath, jwk, jkt, privateKeyJose });

  // Sign WS handshake proof using the same key
  // Reset cache so auth.js loads the test key
  _resetKeyCache();
  const proof = await signHandshakeProof({
    keyFilePath,
    aud: `${SERVER_BASE}/host`,
  });
  _resetKeyCache();

  // Open WS to /host
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${SERVER_WS}/host?proof=${encodeURIComponent(proof)}&clientUsername=${encodeURIComponent(username)}`
    );
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WS connect timeout'));
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timer);
      ws.close(1000, 'test done');
      resolve();
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`WS upgrade rejected: ${res.statusCode}`));
    });
  });
});
