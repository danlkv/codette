// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Custom interaction (consent) handler for the trial-only auth flow.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import express from 'express';
import { claimIfAllowed, revokeTrialClaim } from './trial.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONSENT_HTML = readFileSync(join(__dirname, 'views', 'consent.html'), 'utf8');
const ERROR_HTML   = readFileSync(join(__dirname, 'views', 'error.html'),   'utf8');

const CSRF_COOKIE = 'oauth_csrf';

// Substitutes {title, message, hint} into error.html and returns the rendered
// page. `hint` may contain a small amount of trusted HTML (e.g. <kbd> tags); the
// other fields are escaped.
const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);

function renderError({ title, message, hint }) {
  return ERROR_HTML
    .replace('__TITLE__',   esc(title))
    .replace('__MESSAGE__', esc(message))
    .replace('__HINT__',    hint || '');  // trusted: callers pass safe markup
}

function sendError(res, status, opts) {
  return res.status(status).type('html').send(renderError(opts));
}

const RESTART_HINT =
  'Re-run <kbd>codette login</kbd> in your terminal to start a fresh sign-in.';

export function mountInteractions(app, provider) {
  // Render the consent page
  app.get('/oauth/interaction/:uid', async (req, res) => {
    let details;
    try {
      details = await provider.interactionDetails(req, res);
    } catch (e) {
      return sendError(res, 400, {
        title: 'Sign-in session expired',
        message: 'This sign-in link is no longer valid. Interaction sessions expire after 10 minutes or once they have been used.',
        hint: RESTART_HINT,
      });
    }
    if (details.prompt.name !== 'login' && details.prompt.name !== 'consent') {
      return sendError(res, 400, {
        title: 'Unexpected sign-in step',
        message: `The server requested a step this UI does not handle (${details.prompt.name}).`,
        hint: RESTART_HINT,
      });
    }
    const csrf = randomBytes(16).toString('hex');
    res.cookie(CSRF_COOKIE, csrf, { httpOnly: true, sameSite: 'lax', secure: req.secure });
    const html = CONSENT_HTML
      .replace(/__UID__/g, details.uid)
      .replace(/__CSRF__/g, csrf);
    res.type('html').send(html);
  });

  // Process the trial-button submission
  app.post('/oauth/interaction/:uid/trial', express.urlencoded({ extended: false }), async (req, res) => {
    const submitted = req.body?.csrf;
    const cookieCsrf = req.cookies?.[CSRF_COOKIE];
    if (!submitted || submitted !== cookieCsrf) {
      return sendError(res, 403, {
        title: 'Sign-in request rejected',
        message: 'The form could not be verified (CSRF mismatch). This usually means the page was opened in a different browser session than the one that started the sign-in.',
        hint: RESTART_HINT,
      });
    }

    // Atomic check-and-record: blocks concurrent requests from the same IP from
    // both passing before either records (TOCTOU fix).
    if (!claimIfAllowed(req.ip)) {
      return sendError(res, 429, {
        title: 'Rate limited',
        message: "You've reached the unregistered-access limit from this network.",
        hint: 'Please try again later.',
      });
    }

    // Trial user identity: random sub; no profile.
    const sub = randomBytes(16).toString('hex');

    try {
      const grant = new provider.Grant({ accountId: sub, clientId: 'codette-cli' });
      grant.addOIDCScope('openid offline_access');
      const grantId = await grant.save();

      return await provider.interactionFinished(req, res, {
        login: { accountId: sub },
        consent: { grantId },
      }, { mergeWithLastSubmission: false });
    } catch (err) {
      // Roll back the claim so the IP slot is not permanently consumed by a
      // transient failure. The grant (if saved) will expire naturally.
      revokeTrialClaim(req.ip);
      console.error('[trial] grant/interactionFinished failed:', err);

      // SessionNotFound is by far the most common error here: the interaction
      // record was wiped (server restart with OAUTH_DATA_DIR cleared, or the
      // user took >10 minutes on the consent page).
      const isSessionGone = err?.name === 'SessionNotFound' ||
                            err?.error_description === 'interaction session not found';
      if (isSessionGone) {
        return sendError(res, 400, {
          title: 'Sign-in session expired',
          message: 'The server could not find the sign-in session this form belongs to. It likely expired or the server was restarted.',
          hint: RESTART_HINT,
        });
      }
      return sendError(res, 500, {
        title: 'Something went wrong',
        message: 'We could not complete the sign-in.',
        hint: `${RESTART_HINT} If the problem persists, contact the server operator.`,
      });
    }
  });
}
