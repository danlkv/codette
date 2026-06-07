// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Verify a WS handshake proof JWT for /host connections.
//
// Handshake JWT (signed by host-priv):
//   { iss: jkt, aud: <server>/host, iat, exp: now+60s, jti }
//
// The server looks up the binding by jkt, verifies the signature, and
// enforces iat freshness + SERVER_START_TIME kill-switch + jti dedup.

import { jwtVerify, decodeJwt, importJWK } from 'jose';

// SERVER_START_TIME: any JWT issued before this epoch is rejected.
// Invalidates all outstanding proofs when the server restarts.
export const SERVER_START_TIME = Math.floor(Date.now() / 1000);

/**
 * Verify a host handshake proof.
 *
 * @param {object} opts
 *   proofJwt      — the JWT string
 *   lookupByPubkey — (fp) => {username, jwk} | null
 *   expectedAud   — audience string (e.g. "https://server/host")
 *   jtiCache      — { has(jti): bool, mark(jti, exp): void }
 *
 * @returns { username, jkt } on success, or null on any failure
 */
export async function verifyHandshakeProof({ proofJwt, lookupByPubkey, expectedAud, jtiCache }) {
  // Decode without verifying to extract iss (the jkt)
  let unverified;
  try {
    unverified = decodeJwt(proofJwt);
  } catch {
    return null;
  }

  const fp = unverified.iss;
  if (!fp) return null;

  const binding = lookupByPubkey(fp);
  if (!binding) return null;

  // Import the stored JWK and verify
  let key;
  try {
    key = await importJWK(binding.jwk, 'ES256');
  } catch {
    return null;
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(proofJwt, key, {
      audience:   expectedAud,
      algorithms: ['ES256'],
    }));
  } catch {
    return null;
  }

  // iat freshness: within 5 minutes
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.iat || Math.abs(nowSec - payload.iat) > 300) return null;

  // iat kill-switch: must not predate server start
  if (payload.iat < SERVER_START_TIME) return null;

  // jti dedup
  if (!payload.jti) return null;
  if (jtiCache.has(payload.jti)) return null;
  jtiCache.mark(payload.jti, payload.exp ?? nowSec + 120);

  return { username: binding.username, jkt: fp };
}
