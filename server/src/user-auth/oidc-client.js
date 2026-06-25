// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Generic OIDC client: authorize-URL builder, code → id_token exchange,
// id_token verification against the provider's JWKS.
//
// Confidential clients carry a `client_secret` (sent in token exchange).
// Public/PKCE clients omit `client_secret` and instead bind a per-flow
// code_verifier — the authorize URL carries its SHA-256 challenge, the
// token exchange echoes the verifier.

import { createHash } from 'crypto';
import { jwtVerify, createRemoteJWKSet } from 'jose';

export function buildAuthorizeUrl(provider, { state, nonce, redirectUri, codeVerifier }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     provider.client_id,
    scope:         provider.scope,
    redirect_uri:  redirectUri,
    state,
    nonce,
  });
  if (!provider.client_secret && codeVerifier) {
    params.set('code_challenge', sha256base64url(codeVerifier));
    params.set('code_challenge_method', 'S256');
  }
  return `${provider.authorization_endpoint}?${params}`;
}

export async function exchangeCode(provider, code, redirectUri, codeVerifier) {
  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    client_id:    provider.client_id,
    redirect_uri: redirectUri,
  });
  if (provider.client_secret) {
    body.set('client_secret', provider.client_secret);
  } else if (codeVerifier) {
    body.set('code_verifier', codeVerifier);
  } else {
    throw new Error(`exchangeCode: provider '${provider.issuer}' is PKCE-only but no code_verifier supplied`);
  }
  const resp = await fetch(provider.token_endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`token exchange failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!json.id_token) throw new Error('token exchange: no id_token in response');
  return json.id_token;
}

export async function verifyOidcIdToken(provider, idToken, expectedNonce) {
  const { payload } = await jwtVerify(idToken, provider._jwks, {
    issuer:         provider.issuer,
    audience:       provider.client_id,
    algorithms:     provider.id_token_signing_alg_values_supported,
    requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
  });
  if (payload.nonce !== expectedNonce) {
    throw new Error('id_token: nonce mismatch');
  }
  return { sub: payload.sub, claims: payload };
}

export function attachJwks(provider) {
  provider._jwks = createRemoteJWKSet(new URL(provider.jwks_uri));
}

function sha256base64url(s) {
  return createHash('sha256').update(s).digest('base64url');
}
