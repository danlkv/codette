// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// `codette login` — OAuth Authorization Code + PKCE.
// Opens browser at /oauth/auth, listens on a free localhost port,
// races against a paste prompt for remote-codette installs.

import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, execSync } from 'child_process';
import readline from 'readline';

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE() {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* OK — user will use the printed URL */ }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function listenForCode(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname === '/callback') {
        const code = u.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Authenticated. You can close this window.');
        server.close();
        resolve(code);
      } else {
        res.writeHead(404).end();
      }
    });
    server.listen(port, '127.0.0.1');
    const timeout = setTimeout(() => { server.close(); reject(new Error('timeout')); }, 5 * 60 * 1000);
    server.on('close', () => clearTimeout(timeout));
  });
}

// Queue-based prompt helper: a single readline interface pre-buffers lines so
// sequential asks work correctly even when stdin is piped (non-TTY).
function makePrompt() {
  const lines = [];
  const waiters = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on('line', (line) => {
    if (waiters.length > 0) {
      waiters.shift()(line);
    } else {
      lines.push(line);
    }
  });

  const ask = (question, fallback) => new Promise(resolve => {
    process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ''}: `);
    if (lines.length > 0) {
      const answer = lines.shift();
      resolve(answer.trim() || fallback || '');
    } else {
      waiters.push((answer) => resolve(answer.trim() || fallback || ''));
    }
  });

  const close = () => rl.close();
  return { ask, close };
}

async function exchangeCode({ serverHttp, code, verifier, redirectUri }) {
  const res = await fetch(`${serverHttp}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: 'codette-cli',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

function defaultUsername() {
  try { return execSync('whoami').toString().trim(); } catch { return 'user'; }
}

function generatePassword() {
  // 10-char base36 random — short enough to type, ample entropy
  return randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 10);
}

export async function runLogin({ serverUrl }) {
  const serverHttp = serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

  // Browser↔host chat-domain credentials. These are unrelated to OAuth and
  // are the credentials the user enters in the browser when signing in.
  const configDir = join(homedir(), '.config', 'codette');
  let existing = {};
  const credsPath = join(configDir, 'credentials.json');
  try {
    if (existsSync(credsPath)) existing = JSON.parse(readFileSync(credsPath, 'utf8'));
  } catch {}

  const prompter = makePrompt();
  const username = await prompter.ask('Username', existing.username || defaultUsername());
  const password = await prompter.ask('Password', existing.password || generatePassword());

  // OAuth dance
  const { verifier, challenge } = generatePKCE();
  const port = await findFreePort();
  const stateObj = { port, nonce: randomBytes(8).toString('hex') };
  const state = base64UrlEncode(Buffer.from(JSON.stringify(stateObj)));
  const redirectUri = new URL('/auth/success', serverHttp).href;

  const authUrl = `${serverHttp}/oauth/auth?` + new URLSearchParams({
    response_type: 'code',
    client_id: 'codette-cli',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'openid offline_access',
    prompt: 'consent',
  });

  console.log('\nOpen: ' + authUrl + '\n');
  openBrowser(authUrl);

  // Race localhost listener against paste prompt (same shared rl interface).
  // Empty input (accidental Enter) silently re-prompts.
  async function pastePromptLoop() {
    while (true) {
      const input = await prompter.ask('Enter the code here (Ctrl+C to cancel)', '');
      if (input) return input;
    }
  }
  const code = await Promise.race([
    listenForCode(port).catch(() => new Promise(() => {})),   // never resolves on error → paste wins
    pastePromptLoop(),
  ]);
  prompter.close();
  if (!code) throw new Error('no code received');

  const tokens = await exchangeCode({ serverHttp, code, verifier, redirectUri });

  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    credsPath,
    JSON.stringify({
      server: serverUrl,
      refresh_token: tokens.refresh_token,
      username,
      password,
    }, null, 2),
    { mode: 0o600 }
  );

  console.log('\n✓ Authenticated. Run `codette` to start the host.');
}
