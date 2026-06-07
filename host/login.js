// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// `codette login` — X2 self-signed-identity registration.
// Signs a host_proof with host-key.pem, opens the browser to the consent page,
// and polls /register/status until the binding is confirmed.

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync, spawn } from 'child_process';
import readline from 'readline';
import { signHostProof } from './auth.js';

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* OK — user will use the printed URL */ }
}

// ── Prompt helpers ────────────────────────────────────────────────────────────
export class PromptAborted extends Error {
  constructor() { super('Aborted by user'); this.name = 'PromptAborted'; }
}

function makePrompt() {
  const lines = [];
  const waiters = [];
  let aborted = false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on('line', (line) => {
    if (waiters.length > 0) waiters.shift().resolve(line);
    else lines.push(line);
  });

  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    aborted = true;
    const err = new PromptAborted();
    while (waiters.length) waiters.shift().reject(err);
    rl.close();
  });

  const ask = (question, fallback) => new Promise((resolve, reject) => {
    if (aborted) return reject(new PromptAborted());
    process.stdout.write(`${question}${fallback !== undefined ? ` [${fallback}]` : ''}: `);
    if (lines.length > 0) {
      const answer = lines.shift();
      resolve(answer.trim() || fallback || '');
    } else {
      waiters.push({
        resolve: (line) => resolve(line.trim() || fallback || ''),
        reject,
      });
    }
  });

  const close = () => rl.close();
  return { ask, close };
}

function defaultUsername() {
  try { return execSync('whoami').toString().trim(); } catch { return 'user'; }
}

function generatePassword() {
  return randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 10);
}

// ── Username availability check ───────────────────────────────────────────────
async function checkAvailability(serverHttp, name) {
  let resp;
  try {
    resp = await fetch(`${serverHttp}/auth/username-available/${encodeURIComponent(name)}`);
  } catch (e) {
    throw new Error(`Could not reach the server (${serverHttp}): ${e.message}`);
  }
  const body = await resp.text();
  try {
    return JSON.parse(body);
  } catch {
    const preview = body.slice(0, 60).replace(/\s+/g, ' ');
    console.log(`  (skipping availability check — HTTP ${resp.status}: ${preview}…)`);
    return { available: true, _skipped: true };
  }
}

// ── Main registration flow ────────────────────────────────────────────────────
export async function runLogin({ serverUrl, keyFilePath }) {
  const serverHttp = serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  console.log(`Server: ${serverUrl}`);

  const configDir = join(homedir(), '.config', 'codette');
  let existing = {};
  const credsPath = join(configDir, 'credentials.json');
  try {
    if (existsSync(credsPath)) existing = JSON.parse(readFileSync(credsPath, 'utf8'));
  } catch {}

  const prompter = makePrompt();

  // ── Choose username ──────────────────────────────────────────────────────────
  let username;
  while (true) {
    username = await prompter.ask('Username', existing.username || defaultUsername());
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(username)) {
      console.log('  Invalid: lowercase, start with a letter, 2–32 chars from [a-z0-9_-]');
      continue;
    }
    const { available, reason } = await checkAvailability(serverHttp, username);
    if (available) break;
    console.log(reason === 'invalid' ? '  Invalid username.' : `  '${username}' is already taken.`);
  }

  // ── Browser password (for chat-domain HMAC auth — unrelated to X2 registration) ──
  const password = await prompter.ask('Password', existing.password || generatePassword());
  prompter.close();

  // ── Sign host_proof and assemble URL ─────────────────────────────────────────
  const state = base64UrlEncode(randomBytes(16));
  const { jwt: hostProof, jwk } = await signHostProof({
    keyFilePath,
    aud:      serverHttp + '/register',
    username,
  });
  const jwkB64 = base64UrlEncode(Buffer.from(JSON.stringify(jwk)));

  const registerUrl = `${serverHttp}/register/start?` + new URLSearchParams({
    state,
    username,
    jwk:        jwkB64,
    host_proof: hostProof,
    idp:        'trial',
  });

  console.log('\nOpen: ' + registerUrl + '\n');
  openBrowser(registerUrl);

  // ── Poll /register/status ─────────────────────────────────────────────────
  console.log('Waiting for registration…');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    let resp;
    try {
      resp = await fetch(`${serverHttp}/register/status?state=${encodeURIComponent(state)}`);
    } catch {
      continue; // network blip
    }
    if (!resp.ok) continue;
    const { status } = await resp.json();
    if (status === 'claimed') break;
    if (status === 'error') {
      throw new Error('Registration failed on the server. Check the browser for details.');
    }
    if (status === 'expired') {
      throw new Error('Registration session expired. Run codette login again.');
    }
  }

  if (Date.now() >= deadline) {
    throw new Error('Registration timed out. Run codette login again.');
  }

  // ── Write credentials.json ────────────────────────────────────────────────
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    credsPath,
    JSON.stringify({ server: serverUrl, username, password }, null, 2),
    { mode: 0o600 }
  );

  console.log('\n✓ Registered. Run `codette` to start the host.');
}
