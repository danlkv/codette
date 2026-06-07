// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// id_token minting (trial) and verification (self-issued or future IdPs).

import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'crypto';
import { loadOrGenerateIdTokenKey } from './keys.js';

/**
 * Issue a self-signed trial id_token for the registration flow.
 * sub = jkt (the host's public-key fingerprint).
 */
export async function issueSelfTrialIdToken({ jkt, username, serverIssuer }) {
  const { privateKey } = await loadOrGenerateIdTokenKey();
  return new SignJWT({ username, iss_idp: 'self' })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(serverIssuer)
    .setSubject(jkt)
    .setAudience(serverIssuer + '/register/callback')
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJwtId(randomBytes(16).toString('hex'))
    .sign(privateKey);
}

/**
 * Verify any id_token.
 *
 * knownIssuers: { self: serverIssuer, ... }
 *
 * For v1, only the 'self' branch is implemented.
 * Future: verify against external IdP JWKS by iss.
 *
 * Returns { sub, username, iss_idp } on success; throws on failure.
 */
export async function verifyAnyIdToken({ idToken, expectedAud, knownIssuers }) {
  // Decode without verifying to get iss
  const [, payloadB64] = idToken.split('.');
  let iss;
  try {
    iss = JSON.parse(Buffer.from(payloadB64, 'base64').toString()).iss;
  } catch {
    throw new Error('id_token: malformed payload');
  }

  const selfIssuer = knownIssuers?.self;
  if (selfIssuer && iss === selfIssuer) {
    const { publicKey } = await loadOrGenerateIdTokenKey();
    const { payload } = await jwtVerify(idToken, publicKey, {
      audience: expectedAud,
      algorithms: ['ES256'],
      issuer: selfIssuer,
    });
    return {
      sub:     payload.sub,
      username: payload.username,
      iss_idp: payload.iss_idp || 'self',
    };
  }

  // TODO: External IdP dispatch — verify against IdP's JWKS when iss is in
  // a configured allow-list. Not implemented in v1.
  throw new Error(`id_token: unsupported issuer "${iss}"`);
}
