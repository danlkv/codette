// SPDX-License-Identifier: Apache-2.0
// Confirms /api/sessions actually delegates chat-JWT verification.
// If anyone inlines verification back into requireJwt and orphans
// chat-auth.js, this test catches it.

import { test, expect } from '@playwright/test';
import { SignJWT, importPKCS8, calculateJwkThumbprint, exportJWK } from 'jose';
import { readFileSync } from 'fs';
import { join } from 'path';

const PORT = process.env.TEST_PORT || '3111';
const USERNAME = process.env.TEST_USERNAME || 'testuser';

test('chat-JWT signed with wrong aud is rejected (401)', async ({ request }) => {
  const keyPath = join(process.cwd(), '.dev-data', USERNAME, 'host-key.pem');
  const pem = readFileSync(keyPath, 'utf8');
  const key = await importPKCS8(pem, 'ES256', { extractable: true });
  const { d: _d, ...jwk } = await exportJWK(key);
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');

  const tok = await new SignJWT({ username: USERNAME })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt().setExpirationTime('7d')
    .setAudience(`http://localhost:${PORT}/host`)  // wrong audience for chat
    .setIssuer(`host:${jkt}`)
    .sign(key);

  const r = await request.get(`http://localhost:${PORT}/api/sessions?username=${USERNAME}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  expect(r.status()).toBe(401);
});
