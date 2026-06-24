// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Trial consent endpoint. Issues a self-signed id_token after CSRF + rate-limit
// checks, then redirects to host-enrollment's /register/callback.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import express from 'express';
import { issueSelfTrialIdToken } from './idtoken.js';
import { issueCsrfCookie, verifyCsrf } from './csrf.js';
import { claimIfAllowed, revokeTrialClaim } from './trial.js';
import { escapeHtml } from '../util/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSENT_HTML = readFileSync(path.join(__dirname, 'views/consent.html'), 'utf8');

export function renderTrialConsent(res, { req, name, state }) {
  const csrf = issueCsrfCookie(res, req.secure);
  return res.type('html').send(
    CONSENT_HTML
      .replace('__USERNAME__', escapeHtml(name))
      .replace('__STATE__', escapeHtml(state))
      .replace('__CSRF__', escapeHtml(csrf))
  );
}

/**
 * Mount the trial consent endpoint.
 *
 * @param {import('express').Application} app
 * @param {object} opts
 *   serverIssuer  — e.g. "https://your-server.example.com"
 *   pendingStore  — Map<state, {username, jkt, jwk, idp, expires, ip}>
 *   renderError   — fn({title, message, hint}) → html (provided by host-enrollment)
 */
export function mountConsentRoute(app, { serverIssuer, pendingStore, renderError }) {
  app.post('/register/finish-trial', express.urlencoded({ extended: false }), async (req, res) => {
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

    const entry = pendingStore.get(state);
    if (!entry || Date.now() > entry.expires) {
      pendingStore.delete(state);
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

    const ip = req.ip;
    if (!claimIfAllowed(ip)) {
      return renderError(res, {
        title:   'Rate limit exceeded',
        message: 'Too many trial registrations from this IP address.',
        hint:    'Wait before trying again.',
      });
    }

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
}
