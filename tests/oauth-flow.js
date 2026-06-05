// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Programmatic OAuth Authorization Code + PKCE flow, used by the test harness
// to mint access_tokens without spawning a browser. The CSRF-protected
// interaction handler requires a cookie jar; we maintain one manually.

import { randomBytes, createHash } from 'crypto';

export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePKCE() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// A tiny cookie jar — collects Set-Cookie values and produces the Cookie header.
function makeJar() {
  const jar = new Map();   // name → value
  return {
    consumeResponse(headers) {
      // node-fetch / undici exposes setCookie via .getSetCookie() (Node 20+)
      const setCookies = typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
      for (const sc of setCookies) {
        const [pair] = sc.split(';');
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === '') jar.delete(name);
        else jar.set(name, value);
      }
    },
    header() {
      if (jar.size === 0) return undefined;
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(name) { return jar.get(name); },
  };
}

/**
 * Run a full headless OAuth dance against the given server.
 * Returns { access_token, refresh_token, expires_in, token_type }.
 */
export async function mintAccessToken({ serverBase, port = 0 }) {
  const { verifier, challenge } = generatePKCE();
  const state = b64url(JSON.stringify({ port, nonce: randomBytes(8).toString('hex') }));
  const redirectUri = new URL('/auth/success', serverBase).href;

  const jar = makeJar();
  const fetchWithJar = async (url, init = {}) => {
    const headers = { ...(init.headers || {}) };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    jar.consumeResponse(res.headers);
    return res;
  };

  // 1. /oauth/auth → 303 to /oauth/interaction/<uid>
  const authUrl = `${serverBase}/oauth/auth?` + new URLSearchParams({
    response_type: 'code',
    client_id: 'codette-cli',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'openid offline_access',
    prompt: 'consent',
  });
  let res = await fetchWithJar(authUrl);
  if (res.status !== 303 && res.status !== 302) {
    throw new Error(`expected 303 from /oauth/auth, got ${res.status}: ${await res.text()}`);
  }
  const interactionUrl = new URL(res.headers.get('location'), serverBase).href;

  // 2. GET /oauth/interaction/<uid> → consent HTML + CSRF cookie
  res = await fetchWithJar(interactionUrl);
  if (!res.ok) throw new Error(`interaction GET failed: ${res.status}`);
  const html = await res.text();
  const csrfMatch = html.match(/name="csrf"\s+value="([^"]+)"/);
  if (!csrfMatch) throw new Error('CSRF token not found in consent page');
  const csrf = csrfMatch[1];

  // 3. POST /oauth/interaction/<uid>/trial → 303 to /oauth/auth/<uid>
  const trialUrl = `${interactionUrl}/trial`;
  res = await fetchWithJar(trialUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
  });
  if (res.status !== 303 && res.status !== 302) {
    throw new Error(`expected 303 from /trial, got ${res.status}: ${await res.text()}`);
  }
  const resumeUrl = new URL(res.headers.get('location'), serverBase).href;

  // 4. GET /oauth/auth/<uid> → 303 to /auth/success?code=...
  res = await fetchWithJar(resumeUrl);
  if (res.status !== 303 && res.status !== 302) {
    throw new Error(`expected 303 from resume, got ${res.status}: ${await res.text()}`);
  }
  const finalUrl = new URL(res.headers.get('location'), serverBase);
  const code = finalUrl.searchParams.get('code');
  if (!code) throw new Error(`no code in final redirect: ${finalUrl.href}`);

  // 5. POST /oauth/token
  const tokenRes = await fetch(`${serverBase}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: 'codette-cli',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  return await tokenRes.json();
}
