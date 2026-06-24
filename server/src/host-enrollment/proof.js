// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Verify a host_proof JWT submitted during /register/start.
//
// host_proof payload:
//   { iss: jkt, aud: <server>/register, username, iat, exp: now+5min, jti }
// Signed by the host's private key; the matching public key JWK is also
// supplied in the same request (querystring param `jwk`).

import { importJWK, jwtVerify, calculateJwkThumbprint } from 'jose';

/**
 * Verify a host_proof JWT.
 *
 * @param {object} opts
 *   proofJwt        — the signed JWT string
 *   jwk             — the JWK object (host's public key)
 *   expectedAud     — expected audience string (e.g. "https://server/register")
 *   expectedUsername — username asserted in the proof
 *   jtiCache        — { has(jti): bool, mark(jti, exp): void }
 *
 * @returns { jkt, username } on success
 * @throws Error on any validation failure
 */
export async function verifyHostProof({ proofJwt, jwk, expectedAud, expectedUsername, jtiCache }) {
  // 1. Import the JWK as a crypto key for verification
  let key;
  try {
    key = await importJWK(jwk, 'ES256');
  } catch (e) {
    throw new Error('host_proof: invalid JWK: ' + e.message);
  }

  // 2. Compute the RFC 7638 thumbprint of the supplied JWK
  let jkt;
  try {
    jkt = await calculateJwkThumbprint(jwk, 'sha256');
  } catch (e) {
    throw new Error('host_proof: thumbprint computation failed: ' + e.message);
  }

  // 3. Verify JWT signature + claims (require exp + iat + jti)
  let payload;
  try {
    ({ payload } = await jwtVerify(proofJwt, key, {
      audience:       expectedAud,
      algorithms:     ['ES256'],
      requiredClaims: ['exp', 'iat', 'jti'],
    }));
  } catch (e) {
    throw new Error('host_proof: jwt verification failed: ' + e.message);
  }

  if (payload.username !== expectedUsername) {
    throw new Error('host_proof: username mismatch');
  }

  // iat skew: 30s future, 60s past
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.iat > nowSec + 30) throw new Error('host_proof: iat too far in the future');
  if (payload.iat < nowSec - 60) throw new Error('host_proof: iat too far in the past');

  // 6. iss must equal the JWK thumbprint (proves key ownership)
  if (payload.iss !== jkt) {
    throw new Error('host_proof: iss does not match JWK thumbprint');
  }

  // 7. jti dedup
  if (!payload.jti) throw new Error('host_proof: missing jti');
  if (jtiCache.has(payload.jti)) throw new Error('host_proof: jti already seen (replay)');
  jtiCache.mark(payload.jti, payload.exp ?? nowSec + 600);

  return { jkt, username: payload.username };
}
