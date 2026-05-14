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

/**
 * Derive a non-extractable AES-GCM-256 key from password + username.
 * Uses PBKDF2 with SHA-256, 200 000 iterations.
 */
export async function deriveKey(password, username) {
  const raw = enc.encode(password);
  const salt = enc.encode('codette-e2e-v1:' + username);
  const base = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Derive a non-extractable HMAC-SHA-256 key for deterministic nonce generation.
 * Same password + username, different salt.
 */
export async function deriveNonceKey(password, username) {
  const raw = enc.encode(password);
  const salt = enc.encode('codette-e2e-nonce-v1:' + username);
  const base = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200_000, hash: 'SHA-256' },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
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
 * Compute HMAC-SHA256(key=password, data=nonce).
 * @returns {string}  base64
 */
export async function hmacSign(password, nonce) {
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(nonce));
  return b64e(sig);
}
