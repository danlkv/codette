// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// id_token minting (trial) and verification (self-issued or future IdPs).

import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'crypto';
import { loadOrGenerateIdTokenKey } from './keys.js';

export async function issueSelfTrialIdToken({ jkt, serverIssuer }) {
  const { privateKey } = await loadOrGenerateIdTokenKey();
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(serverIssuer)
    .setSubject(jkt)
    .setAudience(serverIssuer + '/register/callback')
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(randomBytes(16).toString('hex'))
    .sign(privateKey);
}

/**
 * Verify an id_token issued by any configured IdP.
 *
 * For v1, only the self-IdP branch (trial) is implemented.
 * Future: dispatch by iss against a configured IdP allow-list (Google etc.).
 *
 * @returns { sub, idp, claims }
 */
export async function verifyIdToken({ idToken, expectedAud, serverIssuer }) {
  const [, payloadB64] = idToken.split('.');
  let iss;
  try {
    iss = JSON.parse(Buffer.from(payloadB64, 'base64').toString()).iss;
  } catch {
    throw new Error('id_token: malformed payload');
  }

  if (iss === serverIssuer) {
    const { publicKey } = await loadOrGenerateIdTokenKey();
    const { payload } = await jwtVerify(idToken, publicKey, {
      audience:       expectedAud,
      algorithms:     ['ES256'],
      issuer:         serverIssuer,
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    return { sub: payload.sub, idp: 'self', claims: payload };
  }

  throw new Error(`id_token: unsupported issuer "${iss}"`);
}
