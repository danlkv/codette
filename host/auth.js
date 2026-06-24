// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Host-side key management for the host-enrollment flow.
// Uses the same host-key.pem as the chat-domain JWT signer.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { generateKeyPairSync } from 'crypto';
import { randomBytes } from 'crypto';
import { SignJWT, importPKCS8, importJWK, exportJWK, exportSPKI, calculateJwkThumbprint } from 'jose';

let cached = null;  // { key, jwk, jkt, pemPrivate }

/**
 * Load or generate host key material. Single source of truth.
 *   - reads PKCS8 PEM at keyFilePath if it exists
 *   - generates a fresh ES256 keypair and writes it (mode 0600) if missing
 *   - returns { key (jose CryptoKey), jwk (public-only), jkt }
 */
export async function loadOrGenerateKeyMaterial(keyFilePath) {
  if (cached) return cached;

  let pem;
  if (existsSync(keyFilePath)) {
    pem = readFileSync(keyFilePath, 'utf8');
  } else {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    mkdirSync(dirname(keyFilePath), { recursive: true, mode: 0o700 });
    writeFileSync(keyFilePath, privateKey, { mode: 0o600 });
    pem = privateKey;
  }

  const key = await importPKCS8(pem, 'ES256', { extractable: true });
  const { d: _d, ...jwk } = await exportJWK(key);
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  const pubkeyKey = await importJWK(jwk, 'ES256');
  const pemPublic = await exportSPKI(pubkeyKey);
  cached = { key, jwk, jkt, pemPrivate: pem, pemPublic };
  return cached;
}

/**
 * Sign a host_proof JWT for the /register/start flow.
 * aud is <serverHttp>/register
 */
export async function signHostProof({ keyFilePath, aud, username }) {
  const { key, jwk, jkt } = await loadOrGenerateKeyMaterial(keyFilePath);
  const jwt = await new SignJWT({ username })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(jkt).setAudience(aud)
    .setIssuedAt().setExpirationTime('5m')
    .setJti(randomBytes(16).toString('hex'))
    .sign(key);
  return { jwt, jwk, jkt };
}

/**
 * Sign a WS handshake proof JWT for /host connections.
 * aud is <serverHttp>/host
 */
export async function signHandshakeProof({ keyFilePath, aud }) {
  const { key, jkt } = await loadOrGenerateKeyMaterial(keyFilePath);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(jkt).setAudience(aud)
    .setIssuedAt().setExpirationTime('1m')
    .setJti(randomBytes(16).toString('hex'))
    .sign(key);
}

/** Reset cached key material (used in tests to simulate fresh key) */
export function _resetKeyCache() { cached = null; }
