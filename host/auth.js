// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// X2 host-side key management and proof signing.
// Uses the same host-key.pem as the chat-domain JWT signer.

import { readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { SignJWT, importPKCS8, exportJWK, calculateJwkThumbprint } from 'jose';

let cachedKey = null;
let cachedJwk = null;
let cachedJkt = null;

/**
 * Load and cache key material from host-key.pem.
 * keyFilePath: absolute path to host-key.pem
 */
export async function loadKeyMaterial(keyFilePath) {
  if (cachedKey) return { key: cachedKey, jwk: cachedJwk, jkt: cachedJkt };
  const pem = readFileSync(keyFilePath, 'utf8');
  cachedKey = await importPKCS8(pem, 'ES256');
  cachedJwk = await exportJWK(cachedKey);
  // exportJWK on a private key includes d,x,y,crv,kty — strip private fields
  // to produce the public-only JWK that will be shared with the server.
  const { d: _d, ...publicJwk } = cachedJwk;
  cachedJwk = publicJwk;
  cachedJkt = await calculateJwkThumbprint(cachedJwk, 'sha256');
  return { key: cachedKey, jwk: cachedJwk, jkt: cachedJkt };
}

/**
 * Sign a host_proof JWT for the /register/start flow.
 * aud is <serverHttp>/register
 */
export async function signHostProof({ keyFilePath, aud, username }) {
  const { key, jwk, jkt } = await loadKeyMaterial(keyFilePath);
  const jwt = await new SignJWT({ username })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(jkt)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJwtId(randomBytes(16).toString('hex'))
    .sign(key);
  return { jwt, jwk, jkt };
}

/**
 * Sign a WS handshake proof JWT for /host connections.
 * aud is <serverHttp>/host
 */
export async function signHandshakeProof({ keyFilePath, aud }) {
  const { key, jkt } = await loadKeyMaterial(keyFilePath);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(jkt)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('1m')
    .setJwtId(randomBytes(16).toString('hex'))
    .sign(key);
}

/** Reset cached key material (used in tests to simulate fresh key) */
export function _resetKeyCache() {
  cachedKey = null;
  cachedJwk = null;
  cachedJkt = null;
}
