// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Integration test: /host WS takeover semantics.
//
// A second host connection presenting a valid handshake proof signed by the
// SAME key must evict the first connection (close 4001 "taken over…") and
// take its place. The evicted socket's late close event must not unregister
// the new connection.
//
// Boots the real server (child process) with a pre-seeded username binding.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { SignJWT, importPKCS8, calculateJwkThumbprint, exportJWK } from 'jose';
import { WebSocket } from 'ws';
import { WS_CLOSE_TAKEN_OVER, WS_TAKEN_OVER_REASON } from '../../shared/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const USERNAME = 'alice';

let dataDir, serverProc, key, jkt, keyPem;

async function newKey() {
  const { privateKey: pem } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });
  const k = await importPKCS8(pem, 'ES256', { extractable: true });
  const { d: _d, ...jwk } = await exportJWK(k);
  const fp = await calculateJwkThumbprint(jwk, 'sha256');
  return { key: k, jwk, jkt: fp, pem };
}

async function signProof() {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(jkt)
    .setAudience(`${BASE}/host`)
    .setIssuedAt()
    .setExpirationTime('60s')
    .setJti(randomBytes(16).toString('hex'))
    .sign(key);
}

async function connectHost() {
  const proof = await signProof();
  const ws = new WebSocket(
    `ws://localhost:${PORT}/host?proof=${encodeURIComponent(proof)}&clientUsername=${USERNAME}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function nextClose(ws, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: 'TIMEOUT', reason: 'no close event' }), timeoutMs);
    ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  ({ key, jkt, pem: keyPem } = await newKey());
  const { jwk } = await (async () => {
    const { d: _d, ...jwk } = await exportJWK(key);
    return { jwk };
  })();

  dataDir = mkdtempSync(join(tmpdir(), 'codette-takeover-'));
  writeFileSync(join(dataDir, 'username-owners.json'), JSON.stringify({
    byName:   { [USERNAME]: { fp: jkt, claimedAt: Date.now(), idp: 'test', idp_sub: 't' } },
    byPubkey: { [jkt]: { username: USERNAME, jwk } },
  }));
  const providersFile = join(dataDir, 'oidc-providers.jsonc');
  writeFileSync(providersFile,
    `{ "providers": [ { "kind": "trial", "label": "Try without an account" } ] }\n`);

  serverProc = spawn(process.execPath, [join(__dirname, 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CODETTE_DATA_DIR: dataDir,
      CODETTE_OIDC_PROVIDERS_FILE: providersFile,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in 10s')), 10_000);
    serverProc.stdout.on('data', (d) => {
      if (d.toString().includes('listening on port')) { clearTimeout(timer); resolve(); }
    });
    serverProc.once('exit', (c) => reject(new Error(`server exited early (${c})`)));
  });
});

after(() => {
  serverProc?.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
});

test('second same-key connection evicts the first with close 4001', async () => {
  const ws1 = await connectHost();
  const ws1Closed = nextClose(ws1);

  const ws2 = await connectHost();
  const ws2Closed = nextClose(ws2);
  let ws2Close = null;
  ws2Closed.then((c) => { ws2Close = c; });

  const { code, reason } = await ws1Closed;
  assert.equal(code, WS_CLOSE_TAKEN_OVER);
  assert.equal(reason, WS_TAKEN_OVER_REASON);

  await sleep(300); // let the old socket's close event process server-side
  assert.equal(ws2.readyState, WebSocket.OPEN, `ws2 closed: ${JSON.stringify(ws2Close)}`);

  ws2.close();
});

// ── Host-process behavior ─────────────────────────────────────────────────────

function spawnHostProcess(hostDataDir) {
  const proc = spawn(process.execPath,
    [join(__dirname, '../../host/index.js')], {
    env: {
      // Minimal env: no HOME → no real ~/.config/codette/credentials.json
      PATH: process.env.PATH,
      HOME: hostDataDir,
      CODETTE_DATA_HOME: hostDataDir,
      CODETTE_SERVER_URL: `ws://localhost:${PORT}`,
      CODETTE_USERNAME: USERNAME,
      CODETTE_PASSWORD: 'testpass',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  // Attach at spawn time: 'exit' may fire before the test calls waitExit.
  const exitP = new Promise((resolve) =>
    proc.once('exit', (code) => resolve({ exited: true, code })));
  return {
    proc,
    output: () => out,
    waitFor: (needle, ms = 8000) => new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (out.includes(needle)) { clearInterval(poll); resolve(); }
        else if (Date.now() - started > ms) {
          clearInterval(poll);
          reject(new Error(`host did not print ${JSON.stringify(needle)} in ${ms}ms; output:\n${out}`));
        }
      }, 50);
    }),
    waitExit: (ms = 6000) => Promise.race([
      exitP,
      new Promise((resolve) => setTimeout(() => resolve({ exited: false }), ms)),
    ]),
  };
}

test('evicted host process reports takeover and does not reconnect', async () => {
  const hostDataDir = mkdtempSync(join(tmpdir(), 'codette-hostdata-'));
  writeFileSync(join(hostDataDir, 'host-key.pem'), keyPem, { mode: 0o600 });

  const host1 = spawnHostProcess(hostDataDir);
  const host2 = { proc: null };
  try {
    await host1.waitFor('host connected to server');

    const h2 = spawnHostProcess(hostDataDir);
    host2.proc = h2.proc;
    await h2.waitFor('host connected to server');

    const exit1 = await host1.waitExit();
    assert.ok(host1.output().includes('taken over'),
      `host1 should report takeover; output:\n${host1.output()}`);
    assert.deepEqual(exit1, { exited: true, code: 1 });
    assert.ok(!host1.output().includes('reconnecting'),
      `host1 must not reconnect after takeover; output:\n${host1.output()}`);
  } finally {
    host1.proc.kill('SIGKILL');
    host2.proc?.kill('SIGKILL');
    rmSync(hostDataDir, { recursive: true, force: true });
  }
});

test('evicted socket close does not unregister the new connection', async () => {
  const ws1 = await connectHost();
  const ws1Closed = nextClose(ws1);
  const ws2 = await connectHost();
  await ws1Closed;          // ws1 evicted
  await sleep(300);         // ws1 close event fully processed server-side

  // If the registry guard is missing, ws1's close deleted ws2's entry and a
  // third connection installs WITHOUT evicting ws2 → ws2 stays open.
  const ws2Closed = nextClose(ws2);
  const ws3 = await connectHost();
  const { code } = await ws2Closed;
  assert.equal(code, WS_CLOSE_TAKEN_OVER);

  ws3.close();
});
