// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Google OIDC: authorize-URL builder, code-for-id_token exchange,
// id_token verification against Google's JWKS.

import { jwtVerify, createRemoteJWKSet } from 'jose';

export const GOOGLE_OIDC_ISSUER = 'https://accounts.google.com';

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL  = 'https://www.googleapis.com/oauth2/v3/certs';

const JWKS = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

export function isGoogleOidcEnabled() {
  return !!(process.env.GOOGLE_OIDC_CLIENT_ID && process.env.GOOGLE_OIDC_CLIENT_SECRET);
}

export function buildGoogleOidcAuthorizeUrl({ state, nonce, redirectUri }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.GOOGLE_OIDC_CLIENT_ID,
    scope:         'openid',
    redirect_uri:  redirectUri,
    state,
    nonce,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function exchangeGoogleOidcCode(code, redirectUri) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     process.env.GOOGLE_OIDC_CLIENT_ID,
    client_secret: process.env.GOOGLE_OIDC_CLIENT_SECRET,
    redirect_uri:  redirectUri,
  });
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`google token exchange failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!json.id_token) throw new Error('google token exchange: no id_token in response');
  return json.id_token;
}

/**
 * Verify a Google-issued id_token. Used by verifyIdToken's google branch.
 * @returns { sub, claims }
 */
export async function verifyGoogleOidcIdToken(idToken, expectedNonce) {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer:         GOOGLE_OIDC_ISSUER,
    audience:       process.env.GOOGLE_OIDC_CLIENT_ID,
    algorithms:     ['RS256'],
    requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
  });
  if (payload.nonce !== expectedNonce) {
    throw new Error('id_token: nonce mismatch');
  }
  return { sub: payload.sub, claims: payload };
}
