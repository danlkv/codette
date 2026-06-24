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
import { importJWK } from 'jose';
import { verifyHostProof } from './proof.js';
import { isValidUsername, isUsernameClaimed, claimBinding } from './owners.js';
import { makeJtiCache } from './jti-cache.js';
import { revokeTrialClaim } from '../user-auth/trial.js';
import { renderTrialConsent } from '../user-auth/index.js';
import { renderError, escapeHtml } from '../util/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pre-load HTML template at module startup
const DONE_HTML = readFileSync(path.join(__dirname, 'views/done.html'), 'utf8');

// Pending registrations: state → { username, jwk, jkt, idp, expires, ip }
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
 * Mount host-enrollment registration routes on an Express app.
 * @param {import('express').Application} app
 * @param {object} opts
 *   serverIssuer  — e.g. "https://your-server.example.com"
 *   verifyIdToken — fn({idToken, expectedAud, serverIssuer}) → {sub, idp, claims}
 */
export function mountHostEnrollmentRoutes(app, { serverIssuer, verifyIdToken }) {

  // ── GET /register/start ─────────────────────────────────────────────────────
  app.get('/register/start', async (req, res) => {
    const { state, username, jwk: jwkB64, host_proof, idp } = req.query;

    if (!state || !username || !jwkB64 || !host_proof || !idp) {
      return renderError(res, {
        title:   'Missing parameters',
        message: 'state, username, jwk, host_proof, and idp are all required.',
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    // Decode JWK
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

    // Validate JWK is importable
    try {
      await importJWK(jwk, 'ES256');
    } catch (e) {
      return renderError(res, {
        title:   'Invalid JWK',
        message: e.message,
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    // Verify host_proof
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

    // Username validation
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

    // Store pending
    pending.set(state, {
      username: name,
      jwk,
      jkt,
      idp: String(idp),
      expires: Date.now() + 5 * 60 * 1000,
      ip: req.ip,
    });
    statusMap.set(state, 'pending');

    // Branch by idp
    if (idp === 'trial') {
      return renderTrialConsent(res, { req, name, state });
    }

    // TODO: external IdP redirect
    return renderError(res, {
      title:   'IdP not supported',
      message: `idp="${escapeHtml(idp)}" is not implemented yet.`,
      hint:    'Use <kbd>idp=trial</kbd> or wait for a future release.',
    });
  });

  // ── GET /register/callback ───────────────────────────────────────────────────
  app.get('/register/callback', async (req, res) => {
    const { state, id_token } = req.query;

    if (!state || !id_token) {
      return renderError(res, {
        title:   'Missing parameters',
        message: 'state and id_token are required.',
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
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

    // Verify id_token via injected verifyIdToken
    let tokenPayload;
    try {
      const { sub, idp, claims } = await verifyIdToken({
        idToken:     id_token,
        expectedAud: serverIssuer + '/register/callback',
        serverIssuer,
      });
      tokenPayload = { sub, username: claims.username, iss_idp: idp };
    } catch (e) {
      statusMap.set(state, 'error');
      return renderError(res, {
        title:   'Invalid id_token',
        message: e.message,
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    // Assert sub matches jkt and username matches
    if (tokenPayload.sub !== entry.jkt) {
      statusMap.set(state, 'error');
      return renderError(res, {
        title:   'Identity mismatch',
        message: 'id_token subject does not match host key fingerprint.',
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }
    if (tokenPayload.username !== entry.username) {
      statusMap.set(state, 'error');
      return renderError(res, {
        title:   'Username mismatch',
        message: 'id_token username does not match pending registration.',
        hint:    'Run <kbd>codette login</kbd> to start again.',
      });
    }

    // Atomic binding claim
    const result = claimBinding(entry.username, entry.jkt, entry.jwk, {
      idp:     tokenPayload.iss_idp,
      idp_sub: tokenPayload.sub,
    });

    if (result === 'name-taken') {
      if (entry.idp === 'trial') revokeTrialClaim(entry.ip);
      statusMap.set(state, 'error');
      pending.delete(state);
      return renderError(res, {
        title:   'Username taken',
        message: `"${escapeHtml(entry.username)}" was claimed by someone else.`,
        hint:    'Run <kbd>codette login</kbd> and choose a different username.',
      });
    }
    if (result === 'pubkey-taken') {
      if (entry.idp === 'trial') revokeTrialClaim(entry.ip);
      statusMap.set(state, 'error');
      pending.delete(state);
      return renderError(res, {
        title:   'Key already registered',
        message: 'This host key is already bound to another username.',
        hint:    'Delete host-key.pem and run <kbd>codette login</kbd> again to generate a fresh key.',
      });
    }

    // Success
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

    const entry   = pending.get(state);
    const status  = statusMap.get(state);

    // Expired but still in pending map
    if (entry && Date.now() > entry.expires) {
      pending.delete(state);
      statusMap.set(state, 'expired');
      return res.json({ status: 'expired' });
    }

    if (status) return res.json({ status });

    // Unknown state
    return res.json({ status: 'expired' });
  });

  // ── GET /auth/username-available/:name ───────────────────────────────────────
  app.get('/auth/username-available/:name', (req, res) => {
    const name = String(req.params.name || '').toLowerCase();
    if (!isValidUsername(name)) return res.json({ available: false, reason: 'invalid' });
    res.json({ available: !isUsernameClaimed(name) });
  });
}
