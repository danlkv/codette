// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Generate / load the server's id_token signing keypair.
// Stored under $X2_DATA_DIR (default: /data/x2) as id-key.pem (PKCS8 private key).
// Auto-generated on first run.

import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { importPKCS8, importSPKI, exportJWK } from 'jose';

function dataDir() {
  return process.env.X2_DATA_DIR || '/data/x2';
}

function keyFile() {
  return join(dataDir(), 'id-key.pem');
}

let _privateKey  = null;  // CryptoKey (jose)
let _publicKey   = null;  // CryptoKey (jose)
let _publicJwk   = null;  // JWK object

export async function loadOrGenerateIdTokenKey() {
  if (_privateKey) return { privateKey: _privateKey, publicKey: _publicKey, publicJwk: _publicJwk };

  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });

  let privPem, pubPem;
  if (existsSync(keyFile())) {
    privPem = readFileSync(keyFile(), 'utf8');
    pubPem  = createPublicKey(createPrivateKey(privPem))
      .export({ type: 'spki', format: 'pem' });
  } else {
    const kp = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privPem = kp.privateKey;
    pubPem  = kp.publicKey;
    writeFileSync(keyFile(), privPem, { mode: 0o600 });
    console.log('[x2/keys] generated new id_token signing key at', keyFile());
  }

  _privateKey = await importPKCS8(privPem, 'ES256');
  _publicKey  = await importSPKI(pubPem, 'ES256');
  _publicJwk  = await exportJWK(_publicKey);

  return { privateKey: _privateKey, publicKey: _publicKey, publicJwk: _publicJwk };
}
