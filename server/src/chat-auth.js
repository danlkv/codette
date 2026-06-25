// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Chat-domain JWT verification. Used by /api/* (HTTP) and /ws (upgrade)
// to authenticate browser clients against a host. Signed by the host's
// keypair with aud=CHAT_AUD and iss=host:<jkt>; domain-separated from
// /host handshake proofs even though the same key signs both.

import { jwtVerify } from 'jose';

export const CHAT_AUD = 'codette-chat';

export async function verifyChatJwt(token, host) {
  if (!host?.pubkeyKey || !host?.jkt) return null;
  try {
    const { payload } = await jwtVerify(token, await host.pubkeyKey, {
      algorithms:     ['ES256'],
      audience:       CHAT_AUD,
      issuer:         `host:${host.jkt}`,
      requiredClaims: ['exp', 'iat'],
    });
    return payload;
  } catch {
    return null;
  }
}
