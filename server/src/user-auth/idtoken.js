// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// id_token minting (self-IdP trial) and verification dispatcher.

import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'crypto';
import { loadOrGenerateIdTokenKey } from './keys.js';
import { verifyOidcIdToken } from './oidc-client.js';

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
 * Make a verifyIdToken bound to the loaded provider map.
 *
 * @param {object} opts
 *   serverIssuer  — self-IdP issuer
 *   providersByIss — Map<string, Provider> keyed by issuer URL
 * @returns fn({ idToken, nonce }) → { sub, idp, claims }
 */
export function makeVerifyIdToken({ serverIssuer, providersByIss }) {
  return async function verifyIdToken({ idToken, nonce }) {
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

    const provider = providersByIss.get(iss);
    if (!provider) throw new Error(`id_token: unsupported issuer "${iss}"`);

    const { sub, claims } = await verifyOidcIdToken(provider, idToken, nonce);
    return { sub, idp: provider.issuer, claims };
  };
}
