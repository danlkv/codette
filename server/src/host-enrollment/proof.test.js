// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'crypto';
import { SignJWT, importPKCS8, calculateJwkThumbprint, exportJWK } from 'jose';
import { verifyHostProof } from './proof.js';

const AUD = 'https://srv.example/register';
const USERNAME = 'alice';

function freshJtiCache() {
  const seen = new Set();
  return { has: (j) => seen.has(j), mark: (j) => seen.add(j) };
}

async function newKey() {
  const { privateKey: pem } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });
  const key = await importPKCS8(pem, 'ES256', { extractable: true });
  const { d: _d, ...jwk } = await exportJWK(key);
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  return { key, jwk, jkt };
}

test('rejects proof missing exp claim', async () => {
  const { key, jwk, jkt } = await newKey();
  const jwt = await new SignJWT({ username: USERNAME })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(jkt).setAudience(AUD)
    .setIssuedAt().setJti(randomBytes(8).toString('hex'))
    .sign(key);
  await assert.rejects(() => verifyHostProof({
    proofJwt: jwt, jwk, expectedAud: AUD, expectedUsername: USERNAME, jtiCache: freshJtiCache(),
  }));
});

test('rejects iat well in the future (2 minutes)', async () => {
  const { key, jwk, jkt } = await newKey();
  const future = Math.floor(Date.now() / 1000) + 120;
  const jwt = await new SignJWT({ username: USERNAME })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(jkt).setAudience(AUD)
    .setIssuedAt(future).setExpirationTime(future + 300).setJti(randomBytes(8).toString('hex'))
    .sign(key);
  await assert.rejects(() => verifyHostProof({
    proofJwt: jwt, jwk, expectedAud: AUD, expectedUsername: USERNAME, jtiCache: freshJtiCache(),
  }));
});

test('rejects iat well in the past (5 minutes) even with valid exp', async () => {
  const { key, jwk, jkt } = await newKey();
  const nowSec = Math.floor(Date.now() / 1000);
  const past = nowSec - 300;
  const jwt = await new SignJWT({ username: USERNAME })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(jkt).setAudience(AUD)
    .setIssuedAt(past).setExpirationTime(nowSec + 600).setJti(randomBytes(8).toString('hex'))
    .sign(key);
  await assert.rejects(() => verifyHostProof({
    proofJwt: jwt, jwk, expectedAud: AUD, expectedUsername: USERNAME, jtiCache: freshJtiCache(),
  }));
});
