// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Picker page + trial-IdP completion endpoint.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import express from 'express';
import { issueSelfTrialIdToken } from './idtoken.js';
import { issueCsrfCookie, verifyCsrf } from './csrf.js';
import { claimIfAllowed, revoke } from './claim-limits.js';
import { buildGoogleOidcAuthorizeUrl, isGoogleOidcEnabled } from './google-oidc.js';
import { escapeHtml } from '../util/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSENT_HTML = readFileSync(path.join(__dirname, 'views/consent.html'), 'utf8');

export function renderPicker(res, { req, name, state, nonce, serverIssuer }) {
  const csrf = issueCsrfCookie(res, req.secure);
  const googleBlock = isGoogleOidcEnabled()
    ? `<a class="btn-primary" href="${escapeHtml(
        buildGoogleOidcAuthorizeUrl({
          state,
          nonce,
          redirectUri: serverIssuer + '/register/callback',
        })
      )}">Sign in with Google</a>`
    : '';
  const trialLabel = isGoogleOidcEnabled() ? 'Try without an account' : 'Continue';
  return res.type('html').send(
    CONSENT_HTML
      .replace('__USERNAME__',     escapeHtml(name))
      .replace('__STATE__',        escapeHtml(state))
      .replace('__CSRF__',         escapeHtml(csrf))
      .replace('__GOOGLE_BLOCK__', googleBlock)
      .replace('__TRIAL_LABEL__',  escapeHtml(trialLabel))
  );
}

/**
 * @param {import('express').Application} app
 * @param {object} opts
 *   serverIssuer  — e.g. "https://your-server.example.com"
 *   pendingStore  — Map<state, {username, jkt, jwk, nonce, expires, ip, claimedKeys}>
 *   renderError   — fn({title, message, hint}) → html
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

    const ip = req.ip;
    const keys = [`ip:${ip}`, `idp:${serverIssuer}:${entry.jkt}`];
    if (!claimIfAllowed(keys)) {
      return renderError(res, {
        title:   'Rate limit exceeded',
        message: 'Too many trial registrations from this address.',
        hint:    'Wait before trying again.',
      });
    }
    entry.claimedKeys = keys;

    let idToken;
    try {
      idToken = await issueSelfTrialIdToken({ jkt: entry.jkt, serverIssuer });
    } catch (e) {
      revoke(keys);
      entry.claimedKeys = null;
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
