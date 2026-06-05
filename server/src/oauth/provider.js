// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// node-oidc-provider configuration. Trial-only consent flow.

import Provider from 'oidc-provider';
import { FileAdapter } from './storage.js';
import { generateKeyPairSync, createPrivateKey } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

function loadOrGenerateKeypair() {
  const DATA_DIR = process.env.OAUTH_DATA_DIR || '/data/oauth';
  const KEY_FILE = join(DATA_DIR, 'oauth-key.pem');
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(KEY_FILE)) {
    try {
      const priv = readFileSync(KEY_FILE, 'utf8');
      return { privJwk: createPrivateKey(priv).export({ format: 'jwk' }) };
    } catch (err) {
      throw new Error(`Failed to load OAuth signing key from ${KEY_FILE}: ${err.message}`);
    }
  }
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(KEY_FILE, kp.privateKey, { mode: 0o600 });
  return { privJwk: createPrivateKey(kp.privateKey).export({ format: 'jwk' }) };
}

export async function buildProvider(issuer) {
  const { privJwk } = loadOrGenerateKeypair();
  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    const issuerIsLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?($|\/)/.test(issuer);
    if (!issuerIsLocalhost) {
      console.error('[oauth] FATAL: COOKIE_SECRET must be set for non-localhost deployments');
      process.exit(1);
    }
    console.warn('[oauth] COOKIE_SECRET not set; using insecure dev default (localhost only)');
  }
  const provider = new Provider(issuer, {
    adapter: FileAdapter,
    clients: [{
      client_id: 'codette-cli',
      client_secret: undefined,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [new URL('/auth/success', issuer).href],
      application_type: 'native',
      id_token_signed_response_alg: 'ES256',
    }],
    pkce: { required: () => true, methods: ['S256'] },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: false },
    },
    interactions: {
      url(ctx, interaction) {
        return `/oauth/interaction/${interaction.uid}`;
      },
    },
    // JWKS is used for ID tokens / session signing.
    // AccessTokens are opaque random strings (jti). validateHostToken looks them
    // up directly via the adapter; no JWT verification on this path.
    jwks: { keys: [privJwk] },
    ttl: {
      AccessToken:       7 * 24 * 60 * 60,   // 7 days
      RefreshToken:      7 * 24 * 60 * 60,   // 7 days
      AuthorizationCode: 10 * 60,            // 10 minutes
      Session:           24 * 60 * 60,       // 24 hours
      Interaction:       10 * 60,            // 10 minutes
      Grant:             7 * 24 * 60 * 60,   // 7 days (matches refresh-token lifetime)
      IdToken:           60 * 60,            // 1 hour (issued alongside AccessToken)
    },
    cookies: {
      keys: [cookieSecret || 'dev-cookie-secret-change-me'],
    },
    findAccount: async (ctx, sub) => ({
      accountId: sub,
      claims: async () => ({ sub }),
    }),
  });

  return provider;
}
