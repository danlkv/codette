// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

// Validate an OAuth access_token for /host WS connections.
// Returns { sub } if the token is a live AccessToken, null otherwise.
export function makeValidateHostToken(provider) {
  return async function validateHostToken(token) {
    if (!token) return null;
    try {
      const accessToken = await provider.AccessToken.find(token);
      if (!accessToken) return null;
      if (accessToken.isExpired) return null;
      return { sub: accessToken.accountId };
    } catch {
      return null;
    }
  };
}
