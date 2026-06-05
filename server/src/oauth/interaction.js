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

const CSRF_COOKIE = 'oauth_csrf';

export function mountInteractions(app, provider) {
  // Render the consent page
  app.get('/oauth/interaction/:uid', async (req, res) => {
    let details;
    try {
      details = await provider.interactionDetails(req, res);
    } catch (e) {
      return res.status(400).send('Interaction not found or expired');
    }
    if (details.prompt.name !== 'login' && details.prompt.name !== 'consent') {
      return res.status(400).send('Unexpected prompt');
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
      return res.status(403).send('CSRF check failed');
    }

    // Atomic check-and-record: blocks concurrent requests from the same IP from
    // both passing before either records (TOCTOU fix).
    if (!claimIfAllowed(req.ip)) {
      return res.status(429).type('html').send(
        '<h1>Rate limited</h1><p>You\'ve used your trial allotment from this network. Please try again later.</p>'
      );
    }

    // Trial user identity: random sub; no profile.
    const sub = randomBytes(16).toString('hex');

    try {
      const grant = new provider.Grant({ accountId: sub, clientId: 'codette-cli' });
      grant.addOIDCScope('openid');
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
      return res.status(500).type('html').send(
        '<h1>Something went wrong</h1><p>Could not complete the sign-in. Please try again.</p>'
      );
    }
  });
}
