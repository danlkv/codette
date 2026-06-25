// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// host-enrollment registration endpoints:
//   GET  /register/start
//   GET  /register/callback
//   GET  /register/status
//   GET  /auth/username-available/:name

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { randomBytes } from 'crypto';
import { importJWK } from 'jose';
import { verifyHostProof } from './proof.js';
import { isValidUsername, isUsernameClaimed, claimBinding } from './owners.js';
import { makeJtiCache } from './jti-cache.js';
import { claimIfAllowed, revoke } from '../user-auth/claim-limits.js';
import { renderPicker } from '../user-auth/index.js';
import { renderError, escapeHtml } from '../util/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pre-load HTML template at module startup
const DONE_HTML = readFileSync(path.join(__dirname, 'views/done.html'), 'utf8');

// Pending registrations: state → { username, jwk, jkt, nonce, expires, ip, claimedKeys? }
const pending = new Map();
export const pendingStore = pending;

// Status map: state → 'pending' | 'claimed' | 'error'
const statusMap = new Map();

// Per-request JTI cache (shared across all incoming proofs for this server lifetime)
const jtiCache = makeJtiCache();

// Evict expired pending entries every 60 s
setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pending) {
    if (now > entry.expires) {
      pending.delete(state);
      if (statusMap.get(state) === 'pending') statusMap.set(state, 'expired');
    }
  }
}, 60_000).unref?.();

/**
 * @param {import('express').Application} app
 * @param {object} opts
 *   serverIssuer     — base URL used as iss for self-IdP and to build redirect_uri
 *   verifyIdToken    — fn({idToken, nonce}) → {sub, idp, claims}
 *   exchangeOidcCode — fn(provider, code, redirectUri) → Promise<idToken>
 *   providers        — array of loaded provider records
 *   providersByIss   — Map<string, Provider>
 */
export function mountHostEnrollmentRoutes(app, { serverIssuer, verifyIdToken, exchangeOidcCode, providers, providersByIss }) {

  // ── GET /register/start ─────────────────────────────────────────────────────
  app.get('/register/start', async (req, res) => {
    const { state, username, jwk: jwkB64, host_proof } = req.query;

    if (!state || !username || !jwkB64 || !host_proof) {
      return renderError(res, {
        title:   'Missing parameters',
        message: 'state, username, jwk, and host_proof are all required.',
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    let jwk;
    try {
      jwk = JSON.parse(Buffer.from(jwkB64, 'base64url').toString());
    } catch {
      return renderError(res, {
        title:   'Invalid JWK',
        message: 'Could not decode the supplied JWK.',
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    try {
      await importJWK(jwk, 'ES256');
    } catch (e) {
      return renderError(res, {
        title:   'Invalid JWK',
        message: e.message,
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    let jkt;
    try {
      ({ jkt } = await verifyHostProof({
        proofJwt:         host_proof,
        jwk,
        expectedAud:      serverIssuer + '/register',
        expectedUsername: String(username),
        jtiCache,
      }));
    } catch (e) {
      return renderError(res, {
        title:   'Invalid host proof',
        message: e.message,
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    const name = String(username).toLowerCase();
    if (!isValidUsername(name)) {
      return renderError(res, {
        title:   'Invalid username',
        message: `"${escapeHtml(name)}" is not a valid username.`,
        hint:    'Lowercase, start with a letter, 2–32 chars from [a-z0-9_-].',
      });
    }
    if (isUsernameClaimed(name)) {
      return renderError(res, {
        title:   'Username taken',
        message: `"${escapeHtml(name)}" is already registered.`,
        hint:    'Run <kbd>codette login</kbd> and choose a different username.',
      });
    }

    const nonce        = randomBytes(16).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');   // RFC 7636 PKCE
    pending.set(state, {
      username: name,
      jwk,
      jkt,
      nonce,
      codeVerifier,
      expires:     Date.now() + 5 * 60 * 1000,
      ip:          req.ip,
      claimedKeys: null,
    });
    statusMap.set(state, 'pending');

    return renderPicker(res, { req, name, state, nonce, codeVerifier, serverIssuer, providers });
  });

  // ── GET /register/callback ───────────────────────────────────────────────────
  app.get('/register/callback', async (req, res) => {
    const { state: stateParam, id_token, code } = req.query;

    if (!stateParam || (!id_token && !code)) {
      return renderError(res, {
        title:   'Missing parameters',
        message: 'state and either id_token or code are required.',
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    // External-IdP picker buttons encode the picked issuer as `<state>|<iss>`
    // so the callback can pick the right provider for code exchange.
    let state, pickedIssuer = null;
    const sep = String(stateParam).indexOf('|');
    if (sep < 0) {
      state = String(stateParam);
    } else {
      state = String(stateParam).slice(0, sep);
      pickedIssuer = String(stateParam).slice(sep + 1);
    }

    const entry = pending.get(state);
    if (!entry || Date.now() > entry.expires) {
      pending.delete(state);
      return renderError(res, {
        title:   'Session expired',
        message: 'The registration session has expired.',
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    // Code-flow IdPs land here without an id_token; exchange first.
    let idToken = id_token;
    if (!idToken && code) {
      const provider = pickedIssuer && providersByIss && providersByIss.get(pickedIssuer);
      if (!provider) {
        statusMap.set(state, 'error');
        return renderError(res, {
          title:   'Unknown IdP',
          message: `No provider configured for issuer "${escapeHtml(pickedIssuer || '')}".`,
          hint:    'Run <kbd>codette login</kbd> to start again.',
        });
      }
      try {
        idToken = await exchangeOidcCode(provider, code, serverIssuer + '/register/callback', entry.codeVerifier);
      } catch (e) {
        statusMap.set(state, 'error');
        return renderError(res, {
          title:   'OIDC code exchange failed',
          message: e.message,
          hint:    'Run <kbd>codette login</kbd> to start again.',
        });
      }
    }

    let sub, idp;
    try {
      ({ sub, idp } = await verifyIdToken({
        idToken,
        nonce: entry.nonce,
      }));
    } catch (e) {
      statusMap.set(state, 'error');
      return renderError(res, {
        title:   'Invalid id_token',
        message: e.message,
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    // External-IdP code flow rate-limits per IdP identity at this point.
    // (Trial path already rate-limited at /register/finish-trial.)
    if (code) {
      const keys = [`idp:${idp}:${sub}`];
      if (!claimIfAllowed(keys)) {
        statusMap.set(state, 'error');
        return renderError(res, {
          title:   'Rate limit exceeded',
          message: 'Too many registrations from this account.',
          hint:    'Wait before trying again.',
        });
      }
      entry.claimedKeys = (entry.claimedKeys || []).concat(keys);
    }

    const result = claimBinding(entry.username, entry.jkt, entry.jwk, { idp, idp_sub: sub });

    if (result === 'name-taken') {
      revoke(entry.claimedKeys);
      statusMap.set(state, 'error');
      pending.delete(state);
      return renderError(res, {
        title:   'Username taken',
        message: `"${escapeHtml(entry.username)}" was claimed by someone else.`,
        hint:    'Run <kbd>codette login</kbd> and choose a different username.',
      });
    }
    if (result === 'pubkey-taken') {
      revoke(entry.claimedKeys);
      statusMap.set(state, 'error');
      pending.delete(state);
      return renderError(res, {
        title:   'Key already registered',
        message: 'This host key is already bound to another username.',
        hint:    'Delete host-key.pem and run <kbd>codette login</kbd> again to generate a fresh key.',
      });
    }

    pending.delete(state);
    statusMap.set(state, 'claimed');

    return res.type('html').send(
      DONE_HTML.replace(/__USERNAME__/g, escapeHtml(entry.username))
    );
  });

  // ── GET /register/status ─────────────────────────────────────────────────────
  app.get('/register/status', (req, res) => {
    const { state } = req.query;
    if (!state) return res.status(400).json({ status: 'error', reason: 'missing state' });

    const entry  = pending.get(state);
    const status = statusMap.get(state);

    if (entry && Date.now() > entry.expires) {
      pending.delete(state);
      statusMap.set(state, 'expired');
      return res.json({ status: 'expired' });
    }

    if (status) return res.json({ status });

    return res.json({ status: 'expired' });
  });

  // ── GET /auth/username-available/:name ───────────────────────────────────────
  app.get('/auth/username-available/:name', (req, res) => {
    const name = String(req.params.name || '').toLowerCase();
    if (!isValidUsername(name)) return res.json({ available: false, reason: 'invalid' });
    res.json({ available: !isUsernameClaimed(name) });
  });
}
