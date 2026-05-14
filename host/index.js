#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { spawn, execSync } from 'child_process';
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import { ClaudeRenderer, toolSummary } from './renderer.js';
import { RpcServer } from './rpc.js';
import { makeInlineFilePrompt } from '../shared/prompts.js';
import { hmacVerify, deriveKey, deriveNonceKey, encrypt, encryptDet, decrypt } from '../shared/crypto.js';

const APP_NAME         = 'claudeweb';
const SERVER_URL       = process.env.SERVER_URL       || 'ws://localhost:3000';
const CLIENT_USERNAME  = process.env.CLIENT_USERNAME  || execSync('whoami').toString().trim();
const CLIENT_PASSWORD  = process.env.CLIENT_PASSWORD  || 'changeme';
const HOST_TOKEN       = process.env.HOST_KEY         || 'host-key-change-me';
const CLAUDE_DIR       = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const E2E_ENABLED      = process.env.E2E !== '0';
const TRACE            = process.env.CODETTE_TRACE === '1';
function trace(obj) { if (TRACE) process.stdout.write('TRACE ' + JSON.stringify(obj) + '\n'); }

// ── App data directory ────────────────────────────────────────────────────────
function getDataDir() {
  if (process.env.CODETTE_DATA_HOME) return process.env.CODETTE_DATA_HOME;
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, APP_NAME);
  if (process.platform === 'win32') return join(process.env.APPDATA || homedir(), APP_NAME);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_NAME);
  return join(homedir(), '.local', 'share', APP_NAME);
}
const DATA_DIR   = getDataDir();
const NAMES_FILE = join(DATA_DIR, 'session-names.json');

function loadNames() {
  try { return JSON.parse(readFileSync(NAMES_FILE, 'utf8')); } catch { return {}; }
}

function saveName(id, name) {
  const names = loadNames();
  if (name) names[id] = name; else delete names[id];
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(NAMES_FILE, JSON.stringify(names, null, 2));
}

// ── Host keypair ──────────────────────────────────────────────────────────────
const KEY_FILE = join(DATA_DIR, 'host-key.pem');

function loadOrGenerateKeypair() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    const privateKey = readFileSync(KEY_FILE, 'utf8');
    const publicKey = createPublicKey(createPrivateKey(privateKey))
      .export({ type: 'spki', format: 'pem' });
    return { privateKey, publicKey };
  } catch {
    const kp = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync(KEY_FILE, kp.privateKey, { mode: 0o600 });
    return kp;
  }
}

const { privateKey: HOST_PRIV_KEY, publicKey: HOST_PUB_KEY } = loadOrGenerateKeypair();

// ── E2E encryption keys ───────────────────────────────────────────────────────
// Derived from CLIENT_PASSWORD + CLIENT_USERNAME (matches client derivation).
// If password exists and E2E !== '0', keys are always derived.
// E2E=0 is a debug flag that skips key derivation (equivalent to no password).
let encKey = null;
let nonceKey = null;
const encKeyReady = E2E_ENABLED
  ? Promise.all([
      deriveKey(CLIENT_PASSWORD, CLIENT_USERNAME),
      deriveNonceKey(CLIENT_PASSWORD, CLIENT_USERNAME),
    ]).then(([k, nk]) => {
      encKey = k; nonceKey = nk;
      trace({ ts: Date.now(), src: 'host', e2e: 'keys_ready' });
    }).catch(e => { process.stderr.write('e2e key derivation failed: ' + e.message + '\n'); })
  : Promise.resolve(null);

// ── Pending auth challenges ───────────────────────────────────────────────────
const pendingChallenges = new Map(); // nonce → { username, ts }

// --no-dir-privacy: disable cwd-restriction check on get_fs / get_file
const NO_DIR_PRIVACY = process.argv.includes('--no-dir-privacy');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`Usage: node host/index.js [options]

Environment variables:
  SERVER_URL        WebSocket server URL          (default: ws://localhost:3000)
  CLIENT_USERNAME   Username shown in chat        (default: whoami)
  CLIENT_PASSWORD   Password for web login        (default: changeme)
  HOST_KEY          Shared secret with server     (default: host-key-change-me)

Options:
  --no-dir-privacy  Disable cwd-restriction on get_fs/get_file (allows any path)
  --help, -h        Show this help

Example:
  HOST_KEY=secret CLIENT_USERNAME=dan SERVER_URL=wss://chat.example.com node host/index.js
`);
  process.exit(0);
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const A = {
  reset:  '\x1b[0m', bold:  '\x1b[1m', dim:   '\x1b[2m',
  cyan:   '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue:   '\x1b[34m', gray:  '\x1b[90m', red: '\x1b[31m',
};
const w  = (s) => process.stdout.write(s);
const hr = () => w(`${A.dim}${'─'.repeat(60)}${A.reset}\n`);

// ── Centralized logging ────────────────────────────────────────────────────────
function log(level, msg, data = null) {
  const color = level === 'error' ? A.red : level === 'warn' ? A.yellow : A.gray;
  w(`${color}[${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}${A.reset}\n`);
}


// ── Session tracking ──────────────────────────────────────────────────────────
const sessionMetaCache = new Map(); // filePath → { mtime, title, msgCount }

function findSessionFile(sessionId) {
  if (!sessionId) return null;
  const claudeDir = join(CLAUDE_DIR, 'projects');
  try {
    for (const project of readdirSync(claudeDir)) {
      const file = join(claudeDir, project, `${sessionId}.jsonl`);
      try { readFileSync(file); return file; } catch {}
    }
  } catch {}
  return null;
}

function getSessionCwd(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(0, 10)) {
      try {
        const ev = JSON.parse(line);
        if (ev.cwd) return ev.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

function listSessions() {
  const claudeDir = join(CLAUDE_DIR, 'projects');
  const sessions = [];
  const activeIds = new Set(agents.keys());
  const names = loadNames();
  try {
    for (const project of readdirSync(claudeDir)) {
      const projectDir = join(claudeDir, project);
      try {
        for (const file of readdirSync(projectDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const id = file.replace('.jsonl', '');
          const filePath = join(projectDir, file);
          let title = '', ts = 0, msgCount = 0, cwd = null;
          try {
            ts = statSync(filePath).mtimeMs;
            const cached = sessionMetaCache.get(filePath);
            if (cached && cached.mtime === ts) {
              ({ title, msgCount, cwd } = cached);
            } else {
              const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
              for (const line of lines) {
                try {
                  const ev = JSON.parse(line);
                  if (!cwd && ev.cwd) cwd = ev.cwd;
                  if (ev.type === 'user' && typeof ev.message?.content === 'string' && ev.message.content.trim()) {
                    if (!title) title = ev.message.content.slice(0, 80);
                    msgCount++;
                  } else if (ev.type === 'assistant' && ev.message?.stop_reason) {
                    msgCount++;
                  }
                } catch {}
              }
              sessionMetaCache.set(filePath, { mtime: ts, title, msgCount, cwd });
            }
          } catch {}
          const agentEntry = agents.get(id);
          const agentState = agentEntry ? (agentEntry.streaming ? 'running' : 'idle') : null;
          sessions.push({ id, title, ts, agentState, msgCount, cwd, ...(names[id] && { name: names[id] }) });
        }
      } catch {}
    }
  } catch {}
  return sessions.sort((a, b) => b.ts - a.ts);
}

// ── Strip thinking blocks before sending to server ────────────────────────────
function stripThinking(lines) {
  if (!lines?.length) return lines || [];
  return lines.map(line => {
    let ev;
    try { ev = JSON.parse(line); } catch { return line; }
    if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) return line;
    const filtered = ev.message.content.filter(b => b.type !== 'thinking');
    if (filtered.length === ev.message.content.length) return line;
    return JSON.stringify({ ...ev, message: { ...ev.message, content: filtered } });
  });
}

// ── Outbound WS wrapper ───────────────────────────────────────────────────────
// Per-field encryption: `type` stays plaintext for server routing; all other
// fields are encrypted into {nonce, ciphertext}. `log` is always plaintext.
async function hostSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (obj.type !== 'log') {
    trace({ ts: Date.now(), src: 'host', dst: 'server', type: obj.type, e2e: !!encKey });
  }
  if (encKey && obj.type !== 'log') {
    try {
      const { type, ...rest } = obj;
      const { nonce, ciphertext } = await encrypt(encKey, JSON.stringify(rest));
      ws.send(JSON.stringify({ type, nonce, ciphertext }));
      return;
    } catch (e) {
      process.stderr.write('e2e encrypt failed: ' + e.message + '\n');
      return;
    }
  }
  ws.send(JSON.stringify(obj));
}

function sendSessionList() {
  hostSend({ type: 'session_list', sessions: listSessions(), hostCwd: process.cwd() });
}

// ── Agent registry ────────────────────────────────────────────────────────────
// Map<sessionId, { proc, buf, streaming, renderer, sessionId }>
const agents = new Map();

function sendAgentEvent(sessionId, event) {
  hostSend({ type: 'agent_event', sessionId, event });
  // Keep session list fresh so clients see agentState changes without a separate fetch
  if (event === 'streaming' || event === 'idle' || event === 'stopped') sendSessionList();
}

// ── Streaming / terminal rendering ───────────────────────────────────────────
function renderLine(line, agentEntry) {
  const sid = agentEntry.sessionId?.slice(0, 6) ?? '??????';
  const tag = agents.size > 1 ? `${A.gray}[${sid}]${A.reset} ` : '';
  const out = agentEntry.renderer.feed(line, tag);
  if (out) w(out);
}

// ── spawnClaude ───────────────────────────────────────────────────────────────
// sessionIdHint: the --resume sessionId, or null for new session
// cwd: optional working directory override
// Returns the agent entry object.
function spawnClaude(extraArgs = [], sessionIdHint = null, overrideCwd = null) {
  const resumeIdx = extraArgs.indexOf('--resume');
  const resumeId  = resumeIdx !== -1 ? extraArgs[resumeIdx + 1] : null;
  const spawnCwd  = overrideCwd || (resumeId ? getSessionCwd(resumeId) : null);

  log('info', 'spawning claude', { args: extraArgs, cwd: spawnCwd, hint: sessionIdHint?.slice(0, 8) ?? null });

  const proc = spawn('claude', [
    '--dangerously-skip-permissions',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    ...extraArgs,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(spawnCwd && { cwd: spawnCwd }),
  });

  // Use hint as temporary key; replaced once system.init arrives
  const agentEntry = {
    proc,
    buf: '',
    streaming: false,
    renderer: new ClaudeRenderer({ summarize: toolSummary }),
    sessionId: sessionIdHint,  // may be null for new sessions
  };

  // Register under hint so messages can be routed before init arrives
  if (sessionIdHint) agents.set(sessionIdHint, agentEntry);

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trimEnd();
    log('error', `[stderr] ${msg}`);
  });

  proc.stdout.on('data', (chunk) => {
    agentEntry.buf += chunk.toString();
    const lines = agentEntry.buf.split('\n');
    agentEntry.buf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;

      // Parse for internal state transitions first
      let ev = null;
      try { ev = JSON.parse(line); } catch {}

      if (ev) {
        if (ev.type === 'system' && ev.subtype === 'init') {
          const newId = ev.session_id ?? null;
          log('info', `claude → system.init`, { session: newId?.slice(0, 8) });
          w(`${A.gray}session ${newId?.slice(0, 8) ?? '?'}${A.reset}\n`);

          // Re-key agent in the map if sessionId changed or was null
          if (newId && newId !== agentEntry.sessionId) {
            if (agentEntry.sessionId) agents.delete(agentEntry.sessionId);
            agentEntry.sessionId = newId;
            agents.set(newId, agentEntry);
          } else if (newId && !agentEntry.sessionId) {
            agentEntry.sessionId = newId;
            agents.set(newId, agentEntry);
          }

          sendAgentEvent(newId, 'started');

          // Broadcast session list immediately — file may not exist yet so inject
          // a synthetic entry for the new session so it appears in the sidebar now.
          if (newId) {
            const list = listSessions();
            if (!list.find(s => s.id === newId)) {
              list.unshift({ id: newId, title: '', ts: Date.now(), agentState: 'idle', msgCount: 0, cwd: ev.cwd || null });
            }
            hostSend({ type: 'session_list', sessions: list, hostCwd: process.cwd() });
          }
        }

        if (ev.type === 'assistant' && !agentEntry.streaming) {
          agentEntry.streaming = true;
          sendAgentEvent(agentEntry.sessionId, 'streaming');
        }

        if (ev.type === 'result') {
          log('info', `claude → result`, { subtype: ev.subtype, session: agentEntry.sessionId?.slice(0, 8) });
          agentEntry.streaming = false;
          sendAgentEvent(agentEntry.sessionId, 'idle');
          sendSessionList(); // file has content now — updates sidebar with new/updated session
        }
      }

      renderLine(line, agentEntry);

      // Forward stripped line to server
      const sessionId = agentEntry.sessionId;
      const strippedLine = stripThinking([line])[0];
      if (ws?.readyState === WebSocket.OPEN) {
        hostSend({ type: 'claude_line', sessionId, line: strippedLine });
      } else {
        log('warn', 'ws not open, dropping claude line');
      }
    }
  });

  proc.on('exit', (code, signal) => {
    const sessionId = agentEntry.sessionId;
    log('info', `claude exited`, { code, signal, session: sessionId?.slice(0, 8) });

    if (code === 0 || code === null) {
      // Clean exit — remove from map and send stopped
      if (sessionId) agents.delete(sessionId);
      sendAgentEvent(sessionId, 'stopped');
      sendSessionList();
    } else {
      // Unexpected exit — report and remove, do NOT auto-respawn
      log('error', `claude exited unexpectedly`, { code, signal, session: sessionId?.slice(0, 8) });
      if (sessionId) agents.delete(sessionId);
      sendAgentEvent(sessionId, 'stopped');
      sendSessionList();
    }
  });

  return agentEntry;
}

// ── RPC handlers (request/response over WS) ───────────────────────────────────
const rpc = new RpcServer();
rpc.onSend = (type) => trace({ ts: Date.now(), src: 'host', dst: 'server', type });
// Encrypt RPC results when e2e is active — result becomes {nonce, ciphertext}.
// File/dir responses use deterministic nonce (cacheable); others use random nonce.
rpc.encryptResult = async (result, type) => {
  if (!encKey) return result;
  const content = JSON.stringify(result);
  if ((type === 'get_file' || type === 'get_fs') && nonceKey) {
    return encryptDet(encKey, nonceKey, content, content);
  }
  return encrypt(encKey, content);
};

const ALLOWED_PREFIXES = ['/tmp'];
function resolveFsPath(p, sessionCwd) {
  if (!p) return null;
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1);
  if (!p.startsWith('/') && sessionCwd) return join(sessionCwd, p);
  return p;
}
function pathAllowed(p, sessionCwd) {
  if (NO_DIR_PRIVACY) return true;
  if (sessionCwd && p.startsWith(sessionCwd)) return true;
  return ALLOWED_PREFIXES.some(prefix => p.startsWith(prefix + '/') || p === prefix);
}

rpc.register('get_fs', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  const path = resolveFsPath(msg.path, sessionCwd) || sessionCwd;
  if (!path || !pathAllowed(path, sessionCwd)) throw new Error('path outside session cwd');
  const entries = readdirSync(path, { withFileTypes: true })
    .map(e => ({ name: e.name, path: join(path, e.name), isDir: e.isDirectory() }))
    .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  log('info', 'get_fs', { path, entries: entries.length });
  return { entries };
});

const BINARY_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  tiff: 'image/tiff', tif: 'image/tiff', svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

rpc.register('get_file', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  const filePath = resolveFsPath(msg.path, sessionCwd);
  if (!filePath || !pathAllowed(filePath, sessionCwd)) {
    log('error', 'get_file rejected', { raw: msg.path, resolved: filePath, cwd: sessionCwd });
    throw new Error('path outside session cwd');
  }
  const ext = filePath.split('.').pop().toLowerCase();
  const mimeType = BINARY_MIME[ext];
  const buf = readFileSync(filePath);
  const mtime = statSync(filePath).mtimeMs;
  if (mimeType) {
    if (buf.length > 10 * 1024 * 1024) throw new Error('file too large');
    log('info', 'get_file binary ok', { path: filePath, size: buf.length, mimeType });
    return { base64: buf.toString('base64'), mimeType, mtime };
  }
  if (buf.length > 512 * 1024) throw new Error('file too large');
  if (buf.includes(0)) throw new Error('binary file');
  log('info', 'get_file ok', { path: filePath, size: buf.length });
  return { content: buf.toString('utf8'), mtime };
});

rpc.register('get_git_log', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  if (!sessionCwd) throw new Error('no cwd for session');
  const logOut = execSync('git log --format="%H|%s|%aI|%an" -50', { cwd: sessionCwd }).toString().trim();
  const commits = logOut ? logOut.split('\n').map(line => {
    const [hash, subject, date, author] = line.split('|');
    return { hash: hash?.slice(0, 7), subject, date, author };
  }) : [];
  let branch = null;
  try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: sessionCwd }).toString().trim(); } catch {}
  log('info', 'get_git_log', { commits: commits.length, branch });
  return { commits, branch };
});

rpc.register('get_git_status', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  if (!sessionCwd) throw new Error('no cwd for session');
  const out = execSync('git status --porcelain', { cwd: sessionCwd }).toString();
  const files = out.trim() ? out.trim().split('\n').map(l => ({
    xy: l.slice(0, 2),
    path: l.slice(3),
  })) : [];
  log('info', 'get_git_status', { files: files.length });
  return { files };
});

rpc.register('get_git_file_diff', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  if (!sessionCwd) throw new Error('no cwd for session');
  if (!msg.path) throw new Error('path required');
  const MAX = 256 * 1024;
  let diff = execSync(`git diff HEAD -- ${JSON.stringify(msg.path)}`, { cwd: sessionCwd, maxBuffer: MAX + 1 }).toString();
  if (!diff.trim()) diff = execSync(`git diff --cached -- ${JSON.stringify(msg.path)}`, { cwd: sessionCwd, maxBuffer: MAX + 1 }).toString();
  log('info', 'get_git_file_diff', { path: msg.path, size: diff.length });
  return { diff: diff.slice(0, MAX) };
});

rpc.register('get_git_diff', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  if (!sessionCwd) throw new Error('no cwd for session');
  const MAX = 256 * 1024;
  const diff = execSync(`git show --unified=3 ${msg.commit}`, { cwd: sessionCwd, maxBuffer: MAX + 1 }).toString();
  const statOut = execSync(`git diff-tree --no-commit-id -r --numstat ${msg.commit}`, { cwd: sessionCwd }).toString().trim();
  const stat = statOut ? statOut.split('\n').map(l => {
    const [added, deleted, path] = l.split('\t');
    return { added: +added, deleted: +deleted, path };
  }) : [];
  log('info', 'get_git_diff', { commit: msg.commit, size: diff.length, files: stat.length });
  return { diff: diff.slice(0, MAX), stat };
});

rpc.register('get_session_history', (msg) => {
  const { sessionId, offset, limit } = msg;
  const file = findSessionFile(sessionId);
  let lines = [];
  let totalLines = 0;
  if (file) {
    try {
      const raw = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      totalLines = raw.length;
      if (limit != null && offset == null) {
        lines = raw.slice(-limit);
      } else if (offset != null && limit != null) {
        lines = raw.slice(offset, offset + limit);
      } else if (offset != null && offset > 0) {
        lines = raw.slice(offset);
      } else {
        lines = raw;
      }
      log('info', `history sent (${lines.length} lines, offset ${offset ?? 0}, limit ${limit ?? 'none'}, total ${totalLines})`, { sessionId: String(sessionId).slice(0, 8) });
    } catch (e) { log('error', `history read error: ${e.message}`); }
  } else {
    log('warn', `session file not found`, { sessionId: String(sessionId).slice(0, 8) });
  }
  return { lines: stripThinking(lines), totalLines };
});

rpc.register('set_session_name', (msg) => {
  if (!msg.sessionId) throw new Error('sessionId required');
  saveName(msg.sessionId, msg.name || null);
  log('info', 'set_session_name', { session: msg.sessionId.slice(0, 8), name: msg.name });
  sendSessionList();
  return { ok: true };
});

// ── Auth RPC handlers ─────────────────────────────────────────────────────────

rpc.register('auth_challenge', (msg) => {
  const nonce = randomBytes(32).toString('base64');
  pendingChallenges.set(nonce, { username: msg.username, ts: Date.now() });
  // Expire after 60 s
  setTimeout(() => pendingChallenges.delete(nonce), 60_000);
  log('info', 'auth_challenge issued', { username: msg.username });
  return { nonce };
});

rpc.register('auth_verify', async (msg) => {
  const { username, nonce, response } = msg;
  const pending = pendingChallenges.get(nonce);
  if (!pending || pending.username !== username || Date.now() - pending.ts > 60_000) {
    throw new Error('invalid or expired challenge');
  }
  pendingChallenges.delete(nonce);
  const ok = await hmacVerify(CLIENT_PASSWORD, nonce, response);
  if (!ok) throw new Error('authentication failed');
  const token = jwt.sign({ username }, HOST_PRIV_KEY, { algorithm: 'ES256', expiresIn: '7d' });
  await encKeyReady;
  log('info', 'auth_verify ok, token issued', { username });
  return { token };
});

// ── Server connection ─────────────────────────────────────────────────────────
let ws;

function connect() {
  ws = new WebSocket(`${SERVER_URL}/host?token=${encodeURIComponent(HOST_TOKEN)}&clientUsername=${encodeURIComponent(CLIENT_USERNAME)}`);

  ws.on('open', () => {
    hr();
    w(`${A.bold}${A.cyan}Claude Web Host${A.reset}  ${A.gray}${SERVER_URL}${A.reset}\n`);
    w(`${A.dim}Serving clients as: ${A.reset}${A.bold}${CLIENT_USERNAME}${A.reset}  ${A.dim}password: ${A.reset}${A.bold}${CLIENT_PASSWORD}${A.reset}\n`);
    if (NO_DIR_PRIVACY) w(`${A.yellow}[warn] --no-dir-privacy: file access unrestricted${A.reset}\n`);
    hr();
    log('info', 'host connected to server', { url: SERVER_URL });
    // Register public key so server can verify client JWTs
    ws.send(JSON.stringify({ type: 'host_pubkey', pubkey: HOST_PUB_KEY }));
    // Re-announce agent states in one batch so server map is correct after reconnect/restart
    const states = {};
    for (const [sessionId, entry] of agents) {
      if (sessionId) states[sessionId] = entry.streaming ? 'streaming' : 'idle';
    }
    if (Object.keys(states).length > 0) hostSend({ type: 'agent_event', states });
  });

  ws.on('message', async (data) => {
    const raw = data.toString();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Per-field decrypt: if message has nonce+ciphertext, decrypt content and merge,
    // preserving outer routing fields (type, id, sessionId).
    if (msg?.nonce && msg?.ciphertext && encKey) {
      try {
        const inner = JSON.parse(await decrypt(encKey, msg.nonce, msg.ciphertext));
        const { nonce: _, ciphertext: __, ...outer } = msg;
        msg = { ...outer, ...inner };
        trace({ ts: Date.now(), src: 'server', dst: 'host', e2e: 'decrypted', type: msg.type });
      } catch (e) {
        process.stderr.write('e2e decrypt failed: ' + e.message + '\n');
        return;
      }
    } else if (msg?.type && msg.type !== 'log') {
      trace({ ts: Date.now(), src: 'server', dst: 'host', type: msg.type });
    }

    try {
      if (await rpc.handle(ws, msg)) return;
    } catch (e) {
      log('error', 'rpc.handle threw (ws.send failed?)', { type: msg.type, err: e.message });
      return;
    }

    if (msg.type === 'list_sessions') {
      log('info', 'list_sessions requested', { e2e: !!encKey });
      sendSessionList();
      return;
    }

    if (msg.type === 'delete_session') {
      const file = findSessionFile(msg.sessionId);
      if (file) {
        try {
          unlinkSync(file);
          log('info', `deleted session`, { sessionId: String(msg.sessionId).slice(0, 8) });
        } catch (e) { log('error', `delete failed: ${e.message}`); }
      }
      sendSessionList();
      return;
    }

    if (msg.type === 'new_session') {
      const cwd = msg.cwd || null;
      const firstMessage = msg.firstMessage || null;
      const settings = msg.claudeweb_settings ?? {};
      log('info', 'new session requested', { cwd, hasMsg: !!firstMessage });
      if (cwd) {
        try { statSync(cwd); } catch {
          log('error', 'new_session: cwd does not exist', { cwd });
          ws.send(JSON.stringify({ type: 'error', message: `cwd does not exist: ${cwd}` }));
          return;
        }
      }
      const extraArgs = (settings.inlineFiles !== false)
        ? ['--append-system-prompt', makeInlineFilePrompt(cwd)]
        : [];
      const agentEntry = spawnClaude(extraArgs, null, cwd);
      if (firstMessage) {
        // Write after a tick so the process has started reading stdin
        setImmediate(() => {
          agentEntry.proc.stdin.write(
            JSON.stringify({ type: 'user', message: { role: 'user', content: firstMessage } }) + '\n'
          );
        });
      }
      return;
    }

    if (msg.type === 'agent_ctl') {
      const { sessionId, event } = msg;
      const agentEntry = agents.get(sessionId);
      if (!agentEntry) {
        log('warn', 'agent_ctl: no agent for session', { sessionId: String(sessionId).slice(0, 8), event });
        return;
      }
      if (event === 'stop') {
        log('info', 'stopping agent', { sessionId: String(sessionId).slice(0, 8) });
        agentEntry.proc.kill();
      } else if (event === 'interrupt') {
        log('info', 'interrupting agent', { sessionId: String(sessionId).slice(0, 8) });
        agentEntry.proc.kill('SIGUSR1');
      } else {
        log('warn', 'agent_ctl: unknown event', { event });
      }
      return;
    }

    // get_session_history is now an RPC handler (see rpc.register below)

    if (msg.type === 'user') {
      const { sessionId, message } = msg;
      if (!sessionId || !message) {
        log('warn', 'user message missing sessionId or message');
        return;
      }

      w(`\n${A.bold}${A.blue}you${A.reset}  ${message.content}\n`);
      log('info', 'user message → stdin', { preview: String(message.content).slice(0, 60), session: String(sessionId).slice(0, 8) });

      const echoLine = JSON.stringify({ type: 'user', message });
      const sendEcho = () => hostSend({ type: 'claude_line', sessionId, line: echoLine });

      let agentEntry = agents.get(sessionId);
      if (!agentEntry) {
        // No running agent — auto-resume this session then write message
        log('info', 'no agent for session, auto-resuming', { sessionId: String(sessionId).slice(0, 8) });
        agentEntry = spawnClaude(['--resume', sessionId], sessionId);
        // Write after a tick so the process has started; echo after write
        setImmediate(() => {
          const ok = agentEntry.proc.stdin.write(JSON.stringify(msg) + '\n');
          if (!ok) log('warn', 'stdin write buffered (backpressure)');
          sendEcho();
        });
      } else {
        const ok = agentEntry.proc.stdin.write(JSON.stringify(msg) + '\n');
        if (!ok) log('warn', 'stdin write buffered (backpressure)');
        sendEcho();
      }
      return;
    }
  });

  ws.on('close', () => {
    log('warn', 'disconnected from server, reconnecting…');
    setTimeout(connect, 3000);
  });

  ws.on('error', (e) => log('error', `ws error: ${e.message}`));
}

connect();
