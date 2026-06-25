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
import { buildAuthorizeUrl } from './oidc-client.js';
import { providerSvg } from './providers.js';
import { escapeHtml } from '../util/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSENT_HTML = readFileSync(path.join(__dirname, 'views/consent.html'), 'utf8');
const NO_IDPS_HTML = readFileSync(path.join(__dirname, 'views/no-idps.html'), 'utf8');

function renderOidcButton(provider, { state, nonce, redirectUri, codeVerifier }) {
  const augmented = `${state}|${provider.issuer}`;
  const url = buildAuthorizeUrl(provider, { state: augmented, nonce, redirectUri, codeVerifier });
  return `<a class="gsi gsi-${escapeHtml(provider.brand)}" href="${escapeHtml(url)}">` +
           providerSvg(provider) +
           `<span>${escapeHtml(provider.label)}</span>` +
         `</a>`;
}

function renderTrialButton(provider, { state, csrf }) {
  return `<form method="POST" action="/register/finish-trial">` +
           `<input type="hidden" name="state" value="${escapeHtml(state)}">` +
           `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
           `<button class="gsi gsi-${escapeHtml(provider.brand)}" type="submit">` +
             `<span>${escapeHtml(provider.label)}</span>` +
           `</button>` +
         `</form>`;
}

export function renderPicker(res, { req, name, state, nonce, codeVerifier, serverIssuer, providers }) {
  if (!providers || providers.length === 0) {
    return res.type('html').send(NO_IDPS_HTML);
  }
  const csrf = issueCsrfCookie(res, req.secure);
  const redirectUri = serverIssuer + '/register/callback';
  const buttons = providers
    .map(p => p.kind === 'trial'
      ? renderTrialButton(p, { state, csrf })
      : renderOidcButton(p, { state, nonce, redirectUri, codeVerifier }))
    .join('\n    ');
  return res.type('html').send(
    CONSENT_HTML
      .replace('__USERNAME__', escapeHtml(name))
      .replace('__BUTTONS__',  buttons)
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
