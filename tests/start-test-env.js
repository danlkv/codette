#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

/**
 * Starts server + host on a test port for Playwright e2e tests.
 * Usage: TEST_PORT=3111 node tests/start-test-env.js
 *
 * Uses the headless host-enrollment register helper to bind a test keypair before
 * starting the host — mirrors run_dev.sh but without HOST_KEY.
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, symlinkSync, openSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { headlessRegister, generateTestKeypair } from './enrollment-flow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const PORT     = process.env.TEST_PORT || '3111';
const USERNAME = process.env.TEST_USERNAME || 'testuser';
const PASSWORD = process.env.TEST_PASSWORD || 'testpass';

// ── Isolated data dir (like run_dev.sh) ──────────────────────────────────────
const dataDir = join(root, '.dev-data', USERNAME);
const claudeDir = join(dataDir, '.claude');
const enrollmentDataDir = join(dataDir, 'codette');

// Clean slate: remove old session data but preserve credentials symlink
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(claudeDir, { recursive: true });
mkdirSync(enrollmentDataDir, { recursive: true });

// Trial-only providers file for tests — no external IdPs to discover, no env
// vars to set. The repo's oidc-providers.jsonc lists Google etc. which the
// test env doesn't carry secrets for.
const testProvidersFile = join(dataDir, 'oidc-providers.jsonc');
writeFileSync(testProvidersFile,
  `{ "providers": [ { "kind": "trial", "label": "Try without an account" } ] }\n`);

const credSrc = join(homedir(), '.claude', '.credentials.json');
const credDst = join(claudeDir, '.credentials.json');
try { symlinkSync(credSrc, credDst); } catch (e) {
  console.warn(`[test-env] could not symlink credentials: ${e.message}`);
}

let server, host;

function cleanup() {
  host?.kill('SIGTERM');
  server?.kill('SIGTERM');
  setTimeout(() => {
    host?.kill('SIGKILL');
    server?.kill('SIGKILL');
  }, 2000);
}
process.on('SIGTERM', cleanup);
process.on('SIGINT',  cleanup);

// ── Log files ────────────────────────────────────────────────────────────────
const serverLogFd = openSync('/tmp/e2e-server.log', 'w');
const hostLogFd   = openSync('/tmp/e2e-host.log', 'w');

// ── Start server ──────────────────────────────────────────────────────────────
server = spawn('node', ['server/src/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT,
    CODETTE_DATA_DIR:           enrollmentDataDir,
    CODETTE_OIDC_PROVIDERS_FILE: testProvidersFile,
    PUBLIC_URL:                 `http://localhost:${PORT}`,
    SERVER_HOSTNAME:            `localhost:${PORT}`,
  },
  stdio: ['ignore', serverLogFd, serverLogFd],
});

server.on('exit', (code) => {
  console.log(`[test-env] server exited (${code})`);
  host?.kill();
  process.exit(code ?? 1);
});

// ── Wait for server to bind ───────────────────────────────────────────────────
async function waitForPort(port, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok || res.status === 404) return; // SPA fallback also counts
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start on port ${port} within ${timeout}ms`);
}

try {
  await waitForPort(PORT);
  console.log(`[test-env] server ready on :${PORT}`);
} catch (e) {
  console.error(e.message);
  cleanup();
  process.exit(1);
}

// ── Generate keypair and register with server ─────────────────────────────────
// This populates enrollmentDataDir/username-owners.json so the host can connect.
let keypair;
try {
  keypair = await generateTestKeypair();
  await headlessRegister({
    serverBase: `http://localhost:${PORT}`,
    username:   USERNAME,
    keyFilePath: keypair.keyFilePath,
    jwk:         keypair.jwk,
    jkt:         keypair.jkt,
    privateKeyJose: keypair.privateKeyJose,
  });
  // Copy host key to .dev-data/<username>/host-key.pem for e2e tests that need it
  copyFileSync(keypair.keyFilePath, join(dataDir, 'host-key.pem'));
  console.log(`[test-env] host-enrollment registration succeeded for ${USERNAME}`);
} catch (e) {
  console.error(`[test-env] host-enrollment registration failed: ${e.message}`);
  cleanup();
  process.exit(1);
}

// ── Start host ────────────────────────────────────────────────────────────────
const hostEnv = {
  ...process.env,
  SERVER_URL:       `ws://localhost:${PORT}`,
  CLIENT_USERNAME:  USERNAME,
  CLIENT_PASSWORD:  PASSWORD,
  CODETTE_DATA_HOME: keypair.dir,  // dir containing host-key.pem
  CLAUDE_CONFIG_DIR: claudeDir,
};
delete hostEnv.CLAUDECODE;  // allow Claude Code to spawn inside test env

const hostArgs = ['host/index.js', '--server', `ws://localhost:${PORT}`, '--username', USERNAME];
if (process.env.TEST_BACKEND) hostArgs.push('--backend', process.env.TEST_BACKEND);

host = spawn('node', hostArgs, {
  cwd: root,
  env: hostEnv,
  stdio: ['ignore', hostLogFd, hostLogFd],
});

host.on('exit', (code) => {
  console.log(`[test-env] host exited (${code})`);
  server?.kill();
  process.exit(code ?? 1);
});

// Wait for host to connect (server logs "host connected")
const hostStart = Date.now();
while (Date.now() - hostStart < 10000) {
  try {
    if (readFileSync('/tmp/e2e-server.log', 'utf8').includes('host connected')) break;
  } catch {}
  await new Promise(r => setTimeout(r, 100));
}
console.log(`[test-env] ready — server :${PORT}, host connected as ${USERNAME} (${Date.now() - hostStart}ms)`);

// Keep alive until killed (Playwright's webServer expects a long-running process)
await new Promise(() => {});
