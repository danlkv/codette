// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Generic OIDC client operations: authorize-URL builder, code → id_token
// exchange, id_token verification against the provider's JWKS.
// Each operation takes a `provider` object populated by providers.js loader.

import { jwtVerify, createRemoteJWKSet } from 'jose';

export function buildAuthorizeUrl(provider, { state, nonce, redirectUri }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     provider.client_id,
    scope:         provider.scope,
    redirect_uri:  redirectUri,
    state,
    nonce,
  });
  return `${provider.authorization_endpoint}?${params}`;
}

export async function exchangeCode(provider, code, redirectUri) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     provider.client_id,
    client_secret: provider.client_secret,
    redirect_uri:  redirectUri,
  });
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

// Attach a cached JWKS resolver to the provider. Called once at boot per
// provider so providers.js controls the lifetime.
export function attachJwks(provider) {
  provider._jwks = createRemoteJWKSet(new URL(provider.jwks_uri));
}
