#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

/**
 * Starts server + host on a test port for Playwright e2e tests.
 * Usage: TEST_PORT=3111 node tests/start-test-env.js
 *
 * Mirrors run_dev.sh: symlinks ~/.claude credentials into an isolated
 * data dir so the host can spawn Claude Code without leaking production state.
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, symlinkSync, openSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { mintAccessToken } from './oauth-flow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const PORT     = process.env.TEST_PORT || '3111';
const USERNAME = process.env.TEST_USERNAME || 'testuser';
const PASSWORD = process.env.TEST_PASSWORD || 'testpass';

// ── Isolated data dir (like run_dev.sh) ──────────────────────────────────────
const dataDir = join(root, '.dev-data', USERNAME);
const claudeDir = join(dataDir, '.claude');
const oauthDataDir = join(dataDir, 'oauth');
const cookieSecret = 'test-cookie-secret-' + USERNAME;

// Clean slate: remove old session data but preserve credentials symlink
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(claudeDir, { recursive: true });
mkdirSync(oauthDataDir, { recursive: true });

const credSrc = join(homedir(), '.claude', '.credentials.json');
const credDst = join(claudeDir, '.credentials.json');
try { symlinkSync(credSrc, credDst); } catch (e) {
  console.warn(`[test-env] could not symlink credentials: ${e.message}`);
}

let server, host;

function cleanup() {
  // SIGTERM lets host kill its Claude children gracefully
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
    OAUTH_DATA_DIR: oauthDataDir,
    COOKIE_SECRET: cookieSecret,
    PUBLIC_URL: `http://localhost:${PORT}`,
    SERVER_HOSTNAME: `localhost:${PORT}`,
  },
  stdio: ['ignore', serverLogFd, serverLogFd],
});

server.on('exit', (code) => {
  console.log(`[test-env] server exited (${code})`);
  host?.kill();
  process.exit(code ?? 1);
});

// ── Wait for server to bind, then start host ─────────────────────────────────
async function waitForPort(port, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) return;
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

// Mint an access token via the headless OAuth dance so the host can connect
// without needing a saved refresh_token on disk.
let tokens;
try {
  tokens = await mintAccessToken({ serverBase: `http://localhost:${PORT}`, username: USERNAME });
  console.log(`[test-env] OAuth dance succeeded; got access_token (len=${tokens.access_token.length})`);
} catch (e) {
  console.error(`[test-env] OAuth dance failed: ${e.message}`);
  cleanup();
  process.exit(1);
}

const hostEnv = {
  ...process.env,
  SERVER_URL: `ws://localhost:${PORT}`,
  CLIENT_USERNAME: USERNAME,
  CLIENT_PASSWORD: PASSWORD,
  CODETTE_DATA_HOME: dataDir,
  CLAUDE_CONFIG_DIR: claudeDir,
  CODETTE_ACCESS_TOKEN: tokens.access_token,
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
