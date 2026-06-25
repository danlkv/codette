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

const GOOGLE_G_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" aria-hidden="true">' +
    '<path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/>' +
    '<path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"/>' +
    '<path fill="#4CAF50" d="M24,44c5.166,0,9.860-1.977,13.409-5.192l-6.190-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"/>' +
    '<path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571l6.190,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"/>' +
  '</svg>';

export function renderPicker(res, { req, name, state, nonce, serverIssuer }) {
  const csrf = issueCsrfCookie(res, req.secure);
  const googleBlock = isGoogleOidcEnabled()
    ? `<a class="gsi" href="${escapeHtml(
        buildGoogleOidcAuthorizeUrl({
          state,
          nonce,
          redirectUri: serverIssuer + '/register/callback',
        })
      )}">${GOOGLE_G_SVG}<span>Sign in with Google</span></a>`
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
