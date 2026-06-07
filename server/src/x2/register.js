// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// X2 registration endpoints:
//   GET  /register/start
//   POST /register/finish-trial
//   GET  /register/callback
//   GET  /register/status
//   GET  /auth/username-available/:name

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { importJWK } from 'jose';
import express from 'express';
import { verifyHostProof } from './proof.js';
import { issueSelfTrialIdToken, verifyAnyIdToken } from './idtoken.js';
import { issueCsrfCookie, verifyCsrf } from './csrf.js';
import { claimIfAllowed, revokeTrialClaim } from './trial.js';
import { isValidUsername, isUsernameClaimed, claimBinding } from './owners.js';
import { makeJtiCache } from './jti-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pre-load HTML templates at module startup
const CONSENT_HTML = readFileSync(path.join(__dirname, 'views/consent.html'), 'utf8');
const DONE_HTML    = readFileSync(path.join(__dirname, 'views/done.html'), 'utf8');
const ERROR_HTML   = readFileSync(path.join(__dirname, 'views/error.html'), 'utf8');

function renderError(res, { title, message, hint }) {
  return res.status(400).type('html').send(
    ERROR_HTML
      .replace('__TITLE__', escapeHtml(title || 'Error'))
      .replace('__MESSAGE__', escapeHtml(message || ''))
      .replace('__HINT__', hint || '')
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Pending registrations: state → { username, jwk, jkt, idp, expires, ip }
const pending = new Map();

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
 * Mount all X2 registration routes on an Express app.
 * @param {import('express').Application} app
 * @param {string} serverIssuer — e.g. "https://your-server.example.com"
 */
export function mountRegisterRoutes(app, serverIssuer) {

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
      const csrf = issueCsrfCookie(res, req.secure);
      return res.type('html').send(
        CONSENT_HTML
          .replace('__USERNAME__', escapeHtml(name))
          .replace('__STATE__', escapeHtml(state))
          .replace('__CSRF__', escapeHtml(csrf))
      );
    }

    // TODO: external IdP redirect
    return renderError(res, {
      title:   'IdP not supported',
      message: `idp="${escapeHtml(idp)}" is not implemented yet.`,
      hint:    'Use <kbd>idp=trial</kbd> or wait for a future release.',
    });
  });

  // ── POST /register/finish-trial ──────────────────────────────────────────────
  app.post('/register/finish-trial', express.urlencoded({ extended: false }), async (req, res) => {
    // CSRF check
    if (!verifyCsrf(req)) {
      return renderError(res, {
        title:   'CSRF validation failed',
        message: 'Your session may have expired. Please try again.',
        hint:    'Run <kbd>codette login</kbd> to start a fresh registration.',
      });
    }

    const { state } = req.body || {};
    if (!state) {
      return renderError(res, {
        title:   'Missing state',
        message: 'No state parameter in the form submission.',
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

    if (entry.idp !== 'trial') {
      return renderError(res, {
        title:   'IdP mismatch',
        message: 'This endpoint is only for trial registrations.',
        hint:    '',
      });
    }

    // Rate limit check
    const ip = req.ip;
    if (!claimIfAllowed(ip)) {
      return renderError(res, {
        title:   'Rate limit exceeded',
        message: 'Too many trial registrations from this IP address.',
        hint:    'Wait before trying again.',
      });
    }

    // Issue self id_token and redirect to callback
    let idToken;
    try {
      idToken = await issueSelfTrialIdToken({
        jkt:          entry.jkt,
        username:     entry.username,
        serverIssuer,
      });
    } catch (e) {
      revokeTrialClaim(ip);
      return renderError(res, {
        title:   'Token issuance failed',
        message: e.message,
        hint:    'Try again in a moment.',
      });
    }

    return res.redirect(
      `/register/callback?state=${encodeURIComponent(state)}&id_token=${encodeURIComponent(idToken)}`
    );
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

    // Verify id_token
    let tokenPayload;
    try {
      tokenPayload = await verifyAnyIdToken({
        idToken:      id_token,
        expectedAud:  serverIssuer + '/register/callback',
        knownIssuers: { self: serverIssuer },
      });
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

