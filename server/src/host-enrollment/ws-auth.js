// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Verify a WS handshake proof JWT for /host connections.
//
// Replay-resistance is layered:
//   (a) jwtVerify requires exp + checks it against now.
//   (b) The in-memory jtiCache rejects re-presentation within process lifetime.
//   (c) SERVER_START_TIME rejects any proof minted before this process started.
//       (a)+(b) alone do not cover restart: the jtiCache is wiped on restart,
//       so a captured proof could replay within its exp window in the
//       post-restart server before the cache learns its jti. (c) closes that
//       hole at the cost of forcing every connected host to re-sign on
//       restart (handled by the existing reconnect loop — sub-second blip).

import { jwtVerify, decodeJwt, importJWK } from 'jose';

// Any JWT with iat < this is rejected. See file header.
export const SERVER_START_TIME = Math.floor(Date.now() / 1000);

export async function verifyHandshakeProof({ proofJwt, lookupByPubkey, expectedAud, jtiCache }) {
  let unverified;
  try { unverified = decodeJwt(proofJwt); } catch { return null; }

  const fp = unverified.iss;
  if (!fp) return null;

  const binding = lookupByPubkey(fp);
  if (!binding) return null;

  let key;
  try { key = await importJWK(binding.jwk, 'ES256'); } catch { return null; }

  let payload;
  try {
    ({ payload } = await jwtVerify(proofJwt, key, {
      audience:       expectedAud,
      algorithms:     ['ES256'],
      requiredClaims: ['exp', 'iat', 'jti'],
    }));
  } catch { return null; }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.iat > nowSec + 30) return null;
  if (payload.iat < nowSec - 60) return null;

  // Across-restart replay defense
  if (payload.iat < SERVER_START_TIME) return null;

  if (jtiCache.has(payload.jti)) return null;
  jtiCache.mark(payload.jti, payload.exp);

  return { username: binding.username, jkt: fp };
}
