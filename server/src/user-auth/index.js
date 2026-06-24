// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// user-auth module: human-facing identity surface (consent, IdPs).
// Currently: trial self-IdP. Future: Google IdP and others.

export { verifyIdToken, issueSelfTrialIdToken } from './idtoken.js';
export { mountConsentRoute, renderTrialConsent } from './consent.js';
export { issueCsrfCookie } from './csrf.js';
