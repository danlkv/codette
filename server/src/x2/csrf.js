// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Minimal double-submit CSRF cookie pattern.
// Issue: set a random cookie + return the same value for the hidden form field.
// Verify: compare cookie against the submitted form field (constant-time-ish via
// early-return on mismatch, acceptable for a 32-hex token space).

import { randomBytes } from 'crypto';

const COOKIE_NAME = 'x2_csrf';

export function issueCsrfCookie(res, secure) {
  const tok = randomBytes(16).toString('hex');
  res.cookie(COOKIE_NAME, tok, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!secure,
  });
  return tok;
}

export function verifyCsrf(req) {
  const cookieTok = req.cookies?.[COOKIE_NAME];
  const formTok = req.body?.csrf;
  return !!(cookieTok && formTok && cookieTok === formTok);
}
