// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// id_token minting (trial) and verification (self-issued or future IdPs).

import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'crypto';
import { loadOrGenerateIdTokenKey } from './keys.js';
import { GOOGLE_OIDC_ISSUER, verifyGoogleOidcIdToken } from './google-oidc.js';

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
 * Verify an id_token. Routes by `iss` to a configured IdP branch.
 *
 * @param {object} opts
 *   idToken       — the JWT string
 *   serverIssuer  — used for self-IdP iss/aud
 *   nonce         — expected nonce (Google branch only)
 * @returns { sub, idp, claims }
 */
export async function verifyIdToken({ idToken, serverIssuer, nonce }) {
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
      audience:       serverIssuer + '/register/callback',
      algorithms:     ['ES256'],
      issuer:         serverIssuer,
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    return { sub: payload.sub, idp: serverIssuer, claims: payload };
  }

  if (iss === GOOGLE_OIDC_ISSUER) {
    const { sub, claims } = await verifyGoogleOidcIdToken(idToken, nonce);
    return { sub, idp: GOOGLE_OIDC_ISSUER, claims };
  }

  throw new Error(`id_token: unsupported issuer "${iss}"`);
}
