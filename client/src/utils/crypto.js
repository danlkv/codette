// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

/**
 * Shared crypto primitives — works in browsers via Web Crypto API.
 * All functions are async. Strings are UTF-8. Binary is base64.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function b64e(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64d(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

function b64uEncode(buf) {
  return b64e(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s) {
  return b64d(s.replace(/-/g, '+').replace(/_/g, '/'));
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Key derivation ────────────────────────────────────────────────────────────

// PBKDF2 parameters live in exactly one place — all derived keys share the
// same iteration count and hash. Distinct salt labels keep the derived keys
// independent (encryption vs nonce-HMAC vs auth-HMAC).
const PBKDF2_ITERATIONS = 200_000;

async function _pbkdf2Derive(password, saltLabel, algorithm, usages) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(saltLabel), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, algorithm, false, usages,
  );
}

/** Non-extractable AES-GCM-256 key for e2e message encryption. */
export function deriveKey(password, username) {
  return _pbkdf2Derive(
    password, 'codette-e2e-v1:' + username,
    { name: 'AES-GCM', length: 256 },
    ['encrypt', 'decrypt'],
  );
}

/** Non-extractable HMAC-SHA-256 key for deterministic nonce generation. */
export function deriveNonceKey(password, username) {
  return _pbkdf2Derive(
    password, 'codette-e2e-nonce-v1:' + username,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    ['sign'],
  );
}

/**
 * Non-extractable HMAC-SHA-256 key for the login challenge/response.
 * Pre-hashing the password through PBKDF2 means the value sent to
 * `/api/auth/verify` cannot be brute-forced faster than the same 200 000-iter
 * cost as the e2e key. MUST be used to key hmacSign().
 */
export function deriveAuthKey(password, username) {
  return _pbkdf2Derive(
    password, 'codette-auth-v1:' + username,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    ['sign'],
  );
}

// ── Symmetric encrypt / decrypt ───────────────────────────────────────────────

/**
 * Encrypt a string with an AES-GCM key (random nonce).
 * @returns {{ nonce: string, ciphertext: string }}  both base64
 */
export async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return { nonce: b64e(iv), ciphertext: b64e(ct) };
}

/**
 * Encrypt with a deterministic nonce: HMAC-SHA-256(nonceKey, label)[:12].
 * Same (key, nonceKey, label, plaintext) → same ciphertext → cacheable.
 * ONLY safe when `label` uniquely determines `plaintext` (otherwise nonce reuse).
 */
export async function encryptDet(key, nonceKey, label, plaintext) {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', nonceKey, enc.encode(label)));
  const iv = sig.slice(0, 12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return { nonce: b64e(iv), ciphertext: b64e(ct) };
}

/**
 * Decrypt a base64 nonce + ciphertext pair.
 * @returns {string}
 */
export async function decrypt(key, nonce, ciphertext) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64d(nonce) },
    key,
    b64d(ciphertext),
  );
  return dec.decode(pt);
}

// ── URL param packing ────────────────────────────────────────────────────────

/**
 * Pack nonce + ciphertext into a single base64url string for URL query params.
 * Format: base64url(nonce_12_bytes ‖ ciphertext_bytes)
 */
export function packParam(nonce, ciphertext) {
  const nb = b64d(nonce);
  const cb = b64d(ciphertext);
  const buf = new Uint8Array(nb.length + cb.length);
  buf.set(nb, 0);
  buf.set(cb, nb.length);
  return b64uEncode(buf);
}

/**
 * Unpack a base64url query param into { nonce, ciphertext } (both standard base64).
 */
export function unpackParam(param) {
  const buf = b64uDecode(param);
  return { nonce: b64e(buf.slice(0, 12)), ciphertext: b64e(buf.slice(12)) };
}

// ── HMAC ──────────────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA-256(authKey, nonce).
 * `authKey` MUST be a CryptoKey produced by deriveAuthKey() — passing the raw
 * password would leak a value brute-forceable at HMAC speed.
 * @returns {string}  base64
 */
export async function hmacSign(authKey, nonce) {
  const sig = await crypto.subtle.sign('HMAC', authKey, enc.encode(nonce));
  return b64e(sig);
}
