// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'crypto';
import { SignJWT, importPKCS8, importJWK, calculateJwkThumbprint, exportJWK } from 'jose';
import { verifyChatJwt, CHAT_AUD } from './chat-auth.js';

const USERNAME = 'alice';

async function newHost() {
  const { privateKey: pem } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });
  const key = await importPKCS8(pem, 'ES256', { extractable: true });
  const { d: _d, ...jwk } = await exportJWK(key);
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  const host = { pubkeyKey: await importJWK(jwk, 'ES256'), jkt };
  return { key, jkt, host };
}

async function signChat(key, jkt, { aud, iss }) {
  return new SignJWT({ username: USERNAME })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(iss ?? `host:${jkt}`).setAudience(aud)
    .setIssuedAt().setExpirationTime('7d')
    .sign(key);
}

test('accepts chat-JWT with correct aud + iss', async () => {
  const { key, jkt, host } = await newHost();
  const jwt = await signChat(key, jkt, { aud: CHAT_AUD });
  const payload = await verifyChatJwt(jwt, host);
  assert.equal(payload.username, USERNAME);
});

test('rejects chat-JWT with handshake aud (cross-domain replay)', async () => {
  const { key, jkt, host } = await newHost();
  const jwt = await signChat(key, jkt, { aud: 'https://srv.example/host' });
  assert.equal(await verifyChatJwt(jwt, host), null);
});

test('rejects chat-JWT with wrong iss', async () => {
  const { key, jkt, host } = await newHost();
  const jwt = await signChat(key, jkt, { aud: CHAT_AUD, iss: 'host:DIFFERENT' });
  assert.equal(await verifyChatJwt(jwt, host), null);
});
