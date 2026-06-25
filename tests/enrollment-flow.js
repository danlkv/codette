// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Headless host-enrollment registration helper. Used by start-test-env.js and Playwright
// tests to bind a keypair to a username without needing a browser.
//
// Flow:
//   1. Generate an ES256 keypair (or use a provided key file)
//   2. Sign host_proof
//   3. GET /register/start  → get consent page + CSRF cookie
//   4. POST /register/finish-trial  → follow redirect to /register/callback
//   5. GET /register/callback  → confirm 'done'
//   6. Poll /register/status until 'claimed'

import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importPKCS8, exportJWK, calculateJwkThumbprint, SignJWT } from 'jose';
import { randomBytes } from 'crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJar() {
  const jar = new Map();
  return {
    consumeResponse(headers) {
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
 * Generate a temporary ES256 keypair, write the private key to a temp file,
 * and return { keyFilePath, jwk, jkt, loadKeyMaterial }.
 */
export async function generateTestKeypair() {
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const dir = join(tmpdir(), 'codette-test-' + randomBytes(6).toString('hex'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFilePath = join(dir, 'host-key.pem');
  writeFileSync(keyFilePath, kp.privateKey, { mode: 0o600 });

  // Compute JWK + jkt (public key only)
  const privateKeyJose = await importPKCS8(kp.privateKey, 'ES256', { extractable: true });
  const fullJwk = await exportJWK(privateKeyJose);
  const { d: _d, ...jwk } = fullJwk;
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');

  return { keyFilePath, jwk, jkt, privateKeyJose, dir };
}

/**
 * Run a full headless host-enrollment registration dance against the given server.
 * Returns { username, keyFilePath, jkt, jwk }.
 */
export async function headlessRegister({ serverBase, username, keyFilePath, jwk, jkt, privateKeyJose }) {
  if (!username) username = 'test-' + randomBytes(6).toString('hex');

  // Generate keypair if not provided
  if (!keyFilePath) {
    const kp = await generateTestKeypair();
    keyFilePath = kp.keyFilePath;
    jwk = kp.jwk;
    jkt = kp.jkt;
    privateKeyJose = kp.privateKeyJose;
  }

  const state = b64url(randomBytes(16));
  const serverHttp = serverBase;

  // Sign host_proof
  const hostProof = await new SignJWT({ username })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(jkt)
    .setAudience(serverHttp + '/register')
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(randomBytes(16).toString('hex'))
    .sign(privateKeyJose);

  const jwkB64 = b64url(Buffer.from(JSON.stringify(jwk)));

  const jar = makeJar();
  const fetchWithJar = async (url, init = {}) => {
    const headers = { ...(init.headers || {}) };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    jar.consumeResponse(res.headers);
    return res;
  };

  // 1. GET /register/start → picker page + CSRF cookie
  const startUrl = `${serverHttp}/register/start?` + new URLSearchParams({
    state, username, jwk: jwkB64, host_proof: hostProof,
  });
  let res = await fetchWithJar(startUrl);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/register/start failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const html = await res.text();
  const csrfMatch = html.match(/name="csrf"\s+value="([^"]+)"/);
  if (!csrfMatch) throw new Error('CSRF token not found in consent page');
  const csrf = csrfMatch[1];

  // 2. POST /register/finish-trial → 302 to /register/callback
  res = await fetchWithJar(`${serverHttp}/register/finish-trial`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state, csrf }),
  });
  if (res.status !== 302 && res.status !== 303) {
    const body = await res.text();
    throw new Error(`/register/finish-trial expected redirect, got ${res.status}: ${body.slice(0, 200)}`);
  }
  const callbackUrl = new URL(res.headers.get('location'), serverHttp).href;

  // 3. GET /register/callback → done page
  res = await fetchWithJar(callbackUrl);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/register/callback failed (${res.status}): ${body.slice(0, 200)}`);
  }

  // 4. Poll /register/status
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const statusRes = await fetch(`${serverHttp}/register/status?state=${encodeURIComponent(state)}`);
    const { status } = await statusRes.json();
    if (status === 'claimed') break;
    if (status === 'error') throw new Error('Registration failed on server');
    await new Promise(r => setTimeout(r, 100));
  }

  return { username, keyFilePath, jkt, jwk };
}
