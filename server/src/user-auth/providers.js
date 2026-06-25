// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Load oidc-providers.jsonc, interpolate ${VAR}, fetch discovery per issuer,
// merge per-issuer defaults, attach JWKS, and build the dispatcher map.

import { readFileSync, existsSync } from 'fs';
import { stripJsonComments } from '../util/jsonc.js';
import { interpolate }       from '../util/env-interp.js';
import { defaultsForIssuer, svgForBrand } from './brands.js';
import { attachJwks }        from './oidc-client.js';

export async function loadProviders(filePath) {
  if (!existsSync(filePath)) return [];

  let raw;
  try { raw = readFileSync(filePath, 'utf8'); }
  catch (e) { throw new Error(`${filePath}: read failed: ${e.message}`); }

  let parsed;
  try { parsed = JSON.parse(stripJsonComments(raw)); }
  catch (e) { throw new Error(`${filePath}: parse failed: ${e.message}`); }

  const interpolated = interpolate(parsed);   // throws on missing env, listing all
  const entries = Array.isArray(interpolated.providers) ? interpolated.providers : [];
  if (entries.length === 0) return [];

  const providers = entries.map(normaliseEntry);
  await Promise.all(providers.map(fetchDiscovery));
  providers.forEach(attachJwks);
  return providers;
}

function normaliseEntry(entry) {
  if (!entry.issuer || typeof entry.issuer !== 'string') {
    throw new Error(`oidc-providers: entry missing 'issuer' field`);
  }
  if (!entry.client_id) {
    throw new Error(`oidc-providers: '${entry.issuer}' missing 'client_id'`);
  }
  if (!entry.client_secret) {
    throw new Error(`oidc-providers: '${entry.issuer}' missing 'client_secret'`);
  }
  const def = defaultsForIssuer(entry.issuer);
  const merged = {
    issuer:        entry.issuer,
    client_id:     entry.client_id,
    client_secret: entry.client_secret,
    label:         entry.label || def.label,
    brand:         entry.brand || def.brand,
    scope:         entry.scope || def.scope,
  };
  if (!merged.label) {
    throw new Error(`oidc-providers: '${entry.issuer}' has no 'label' and no built-in default; supply 'label'`);
  }
  return merged;
}

async function fetchDiscovery(provider) {
  const url = provider.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
  let resp;
  try { resp = await fetch(url); }
  catch (e) { throw new Error(`oidc-providers: '${provider.issuer}' discovery fetch failed: ${e.message}`); }
  if (!resp.ok) {
    throw new Error(`oidc-providers: '${provider.issuer}' discovery returned ${resp.status}`);
  }
  const doc = await resp.json();
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!doc[k]) throw new Error(`oidc-providers: '${provider.issuer}' discovery missing '${k}'`);
  }
  provider.authorization_endpoint = doc.authorization_endpoint;
  provider.token_endpoint         = doc.token_endpoint;
  provider.jwks_uri               = doc.jwks_uri;
  provider.id_token_signing_alg_values_supported =
    Array.isArray(doc.id_token_signing_alg_values_supported) && doc.id_token_signing_alg_values_supported.length > 0
      ? doc.id_token_signing_alg_values_supported
      : ['RS256'];
}

export function providerSvg(provider) {
  return svgForBrand(provider.brand);
}
