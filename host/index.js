#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { execSync, execFileSync } from 'child_process';
import { createSpawnSession, createSdkSession } from './session.js';
import { randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, relative, isAbsolute } from 'path';
import { SignJWT } from 'jose';
import { ClaudeRenderer, toolSummary } from './renderer.js';
import { RpcServer } from './rpc.js';
import { makeInlineFilePrompt, HTML_RENDER_PROMPT } from '../shared/prompts.js';
import { hmacVerify, deriveKey, deriveNonceKey, deriveAuthKey, encrypt, encryptDet, decrypt } from '../shared/crypto.js';
import { APP_NAME } from '../shared/constants.js';
import { signHandshakeProof, loadOrGenerateKeyMaterial } from './auth.js';

// ── Config loading ──────────────────────────────────────────────────────────
// Precedence: CLI flags > env vars > credentials.json > defaults

const CREDS_PATH = join(homedir(), '.config', 'codette', 'credentials.json');

function loadCredentials() {
  try { if (existsSync(CREDS_PATH)) return JSON.parse(readFileSync(CREDS_PATH, 'utf8')); } catch {}
  return {};
}

function parseCliFlags() {
  const flags = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--server' || args[i] === '-s') && args[i + 1]) flags.server = args[++i];
    else if ((args[i] === '--username' || args[i] === '-u') && args[i + 1]) flags.username = args[++i];
    else if ((args[i] === '--password' || args[i] === '-p') && args[i + 1]) flags.password = args[++i];
    else if (args[i] === '--backend' && args[i + 1]) flags.backend = args[++i];
    else if (args[i] === '--permission-mode' && args[i + 1]) flags.permissionMode = args[++i];
  }
  return flags;
}

const _cli = parseCliFlags();
const _creds = loadCredentials();
// True iff the active CLIENT_PASSWORD will come from credentials.json (no
// higher-precedence source provided one). Used to gate the banner line that
// points users at the creds file — pointless to print when the password
// actually came from a CLI flag or env var.
const _passwordFromCreds = !_cli.password
  && !process.env.CODETTE_PASSWORD
  && !process.env.CLIENT_PASSWORD
  && !!_creds.password;

const SERVER_URL = _cli.server
  || process.env.CODETTE_SERVER_URL || process.env.SERVER_URL
  || _creds.server || 'ws://localhost:3000';
const CLIENT_USERNAME = _cli.username
  || process.env.CODETTE_USERNAME || process.env.CLIENT_USERNAME
  || _creds.username || execSync('whoami').toString().trim();
const CLIENT_PASSWORD = _cli.password
  || process.env.CODETTE_PASSWORD || process.env.CLIENT_PASSWORD
  || _creds.password || 'changeme';
const CLAUDE_DIR       = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const E2E_ENABLED      = process.env.E2E !== '0';
// Client-originated types that must arrive encrypted under e2e. Server-initiated
// reads (get_*, auth_*) flow plaintext — their routing fields are server-built.
const E2E_REQUIRED_TYPES = new Set([
  'user', 'agent_ctl', 'permission_response',
  'list_sessions', 'delete_session', 'set_session_name',
]);
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
const HOST_KEY_PATH = join(DATA_DIR, 'host-key.pem');
const { key: HOST_PRIV_KEY_JOSE, jkt: HOST_JKT, pemPublic: HOST_PUB_KEY } = await loadOrGenerateKeyMaterial(HOST_KEY_PATH);

// ── E2E encryption keys ───────────────────────────────────────────────────────
// Derived from CLIENT_PASSWORD + CLIENT_USERNAME (matches client derivation).
// If password exists and E2E !== '0', keys are always derived.
// E2E=0 is a debug flag that skips key derivation (equivalent to no password).
let encKey = null;
let nonceKey = null;
// authKey is always derived (even when E2E=0) because it backs the login
// challenge — the auth flow runs regardless of whether message-body e2e is on.
let authKey = null;
const authKeyReady = deriveAuthKey(CLIENT_PASSWORD, CLIENT_USERNAME)
  .then(k => { authKey = k; })
  .catch(e => { process.stderr.write('auth key derivation failed: ' + e.message + '\n'); });
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

// ── Version ──────────────────────────────────────────────────────────────────
const HOST_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write(`Codette host v${HOST_VERSION}\n`);
  process.exit(0);
}

// ── Subcommands ──────────────────────────────────────────────────────────────
if (process.argv[2] === 'update') {
  const installDir = join(homedir(), '.local', 'share', 'codette');
  const httpUrl = SERVER_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  try {
    process.stdout.write('Pulling latest source...\n');
    let gitOk = false;
    try {
      execSync('git fetch --depth 1 origin', { cwd: installDir, stdio: 'inherit' });
      execSync('git reset --hard origin/HEAD', { cwd: installDir, stdio: 'inherit' });
      gitOk = true;
    } catch {}
    if (!gitOk) {
      process.stdout.write('git failed, downloading tarball from server...\n');
      execSync(`curl -fsSL "${httpUrl}/host.tar.gz" | tar xz -C "${installDir}" --strip-components=0`, { stdio: 'inherit' });
    }
    process.stdout.write('Installing dependencies...\n');
    execSync('npm install', { cwd: join(installDir, 'host'), stdio: 'inherit' });
    process.stdout.write('Update complete.\n');
  } catch (e) {
    process.stderr.write(`Update failed: ${e.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// --no-dir-privacy: disable cwd-restriction check on get_fs / get_file
const NO_DIR_PRIVACY = process.argv.includes('--no-dir-privacy');

// ── login subcommand ──────────────────────────────────────────────────────────
if (process.argv[2] === 'login') {
  try {
    const { runLogin, PromptAborted } = await import('./login.js');
    await runLogin({ serverUrl: SERVER_URL, keyFilePath: HOST_KEY_PATH });
    process.exit(0);
  } catch (e) {
    if (e?.name === 'PromptAborted') { process.exit(130); }
    process.stderr.write(`Login failed: ${e.message}\n`);
    process.exit(1);
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`Usage: codette [options]
       codette login            Register this host with the server
       codette update           Pull latest source + reinstall dependencies

Options:
  -s, --server <url>    Server WebSocket URL
  -u, --username <name> Username shown in chat
  -p, --password <pass> Password for web login
  --backend <type>      Session backend: sdk (default) or spawn
  --permission-mode <m> Permission mode (default: bypassPermissions)
  --no-dir-privacy      Disable cwd-restriction on get_fs/get_file
  -v, --version         Print version
  -h, --help            Show this help

Config precedence: CLI flags > env vars > ~/.config/codette/credentials.json > defaults

Environment variables:
  CODETTE_SERVER_URL    WebSocket server URL (default: ws://localhost:3000)
  CODETTE_USERNAME      Username shown in chat (default: whoami)
  CODETTE_PASSWORD      Password for web login (default: changeme)

Legacy env vars also supported: SERVER_URL, CLIENT_USERNAME, CLIENT_PASSWORD
`);
  process.exit(0);
}

if (!_creds.username && !_cli.username && !process.env.CODETTE_USERNAME && !process.env.CLIENT_USERNAME) {
  process.stderr.write('codette: no username configured.\n');
  process.stderr.write('  Run:  codette login\n');
  process.exit(1);
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

// Claude session IDs are UUIDs; anything else is a traversal attempt.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function findSessionFile(sessionId) {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const claudeDir = join(CLAUDE_DIR, 'projects');
  try {
    for (const project of readdirSync(claudeDir)) {
      const projectDir = join(claudeDir, project);
      const file = join(projectDir, `${sessionId}.jsonl`);
      const rel = relative(projectDir, file);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
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
          const sess = agents.get(id);
          const agentState = sess ? (sess.streaming ? 'running' : 'idle') : null;
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
// Map<sessionId, session>
const agents = new Map();
// Map<toolUseId, {resolve, reject}> — pending SDK permission requests awaiting browser response
const pendingPermissions = new Map();

function sendAgentEvent(sessionId, event) {
  hostSend({ type: 'agent_event', sessionId, event });
  // Keep session list fresh so clients see agentState changes without a separate fetch
  if (event === 'streaming' || event === 'idle' || event === 'stopped') sendSessionList();
}

// ── startSession ─────────────────────────────────────────────────────────────
// Creates a Claude session via the session abstraction layer.
// sessionIdHint: the --resume sessionId, or null for new session
// cwd: optional working directory override
function startSession(extraArgs = [], sessionIdHint = null, overrideCwd = null) {
  const resumeIdx = extraArgs.indexOf('--resume');
  const resumeId  = resumeIdx !== -1 ? extraArgs[resumeIdx + 1] : null;
  let spawnCwd   = overrideCwd || (resumeId ? getSessionCwd(resumeId) : null);
  // If recorded cwd doesn't exist on this host (e.g., session was created on
  // another machine), fall back to $HOME — spawn would fail with a misleading
  // "binary failed to launch" error otherwise.
  if (spawnCwd && !existsSync(spawnCwd)) {
    log('warn', `session cwd does not exist on this host, falling back to home`, { cwd: spawnCwd, fallback: homedir() });
    spawnCwd = homedir();
  }
  const backend   = _cli.backend || 'sdk';

  log('info', 'starting session', { backend, args: extraArgs, cwd: spawnCwd, hint: sessionIdHint?.slice(0, 8) ?? null });

  let session;
  if (backend === 'sdk') {
    // Extract --append-system-prompt value from extraArgs if present
    let systemPrompt = null;
    const sysIdx = extraArgs.indexOf('--append-system-prompt');
    if (sysIdx !== -1) systemPrompt = extraArgs[sysIdx + 1];

    session = createSdkSession({
      cwd: spawnCwd,
      permissionMode: _cli.permissionMode || 'bypassPermissions',
      resume: resumeId || undefined,
      systemPrompt,
    });
  } else {
    const permFlag = _cli.permissionMode
      ? ['--permission-mode', _cli.permissionMode]
      : ['--dangerously-skip-permissions'];
    session = createSpawnSession([
      'claude',
      ...permFlag,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      ...extraArgs,
    ], spawnCwd);
  }

  session.sessionId = sessionIdHint;
  const renderer = new ClaudeRenderer({ summarize: toolSummary });

  if (sessionIdHint) agents.set(sessionIdHint, session);

  session.onInit = (newId, ev) => {
    log('info', `claude → system.init`, { session: newId?.slice(0, 8) });
    w(`${A.gray}session ${newId?.slice(0, 8) ?? '?'}${A.reset}\n`);

    // Re-key in the map if sessionId changed or was null
    if (newId && newId !== session.sessionId) {
      if (session.sessionId) agents.delete(session.sessionId);
    }
    if (newId) agents.set(newId, session);
    session.sessionId = newId;

    sendAgentEvent(newId, 'started');

    // Echo first message back to client (deferred until sessionId is known)
    if (session.pendingEcho) {
      hostSend({ type: 'claude_line', sessionId: newId, line: session.pendingEcho });
      session.pendingEcho = null;
    }

    // Broadcast session list immediately — file may not exist yet so inject
    // a synthetic entry for the new session so it appears in the sidebar now.
    if (newId) {
      const list = listSessions();
      if (!list.find(s => s.id === newId)) {
        list.unshift({ id: newId, title: '', ts: Date.now(), agentState: 'idle', msgCount: 0, cwd: ev.cwd || null });
      }
      hostSend({ type: 'session_list', sessions: list, hostCwd: process.cwd() });
    }
  };

  session.onState = (state) => {
    if (state === 'streaming') {
      sendAgentEvent(session.sessionId, 'streaming');
    } else if (state === 'idle') {
      log('info', `claude → result`, { session: session.sessionId?.slice(0, 8) });
      sendAgentEvent(session.sessionId, 'idle');
      sendSessionList();
    } else if (state === 'stopped') {
      log('info', `claude stopped`, { session: session.sessionId?.slice(0, 8) });
      if (session.sessionId) agents.delete(session.sessionId);
      sendAgentEvent(session.sessionId, 'stopped');
      sendSessionList();
    }
  };

  session.onLine = (line) => {
    // Terminal rendering
    const sid = session.sessionId?.slice(0, 6) ?? '??????';
    const tag = agents.size > 1 ? `${A.gray}[${sid}]${A.reset} ` : '';
    const out = renderer.feed(line, tag);
    if (out) w(out);

    // Forward stripped line to server
    const strippedLine = stripThinking([line])[0];
    if (ws?.readyState === WebSocket.OPEN) {
      hostSend({ type: 'claude_line', sessionId: session.sessionId, line: strippedLine });
    } else {
      log('warn', 'ws not open, dropping claude line');
    }
  };

  // SDK permission relay: forward canUseTool requests to browser
  if (backend === 'sdk') {
    session.onPermission = ({ toolName, input, toolUseId, title, displayName, description, handler }) => {
      log('info', 'permission request', { tool: toolName, session: session.sessionId?.slice(0, 8) });
      pendingPermissions.set(toolUseId, { handler, input });
      hostSend({
        type: 'permission_request',
        sessionId: session.sessionId,
        toolUseId, toolName, input,
        title, displayName, description,
      });
    };
  }

  return session;
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
  return resolve(sessionCwd || '/', p);
}
function pathAllowed(p, sessionCwd) {
  if (NO_DIR_PRIVACY) return true;
  if (sessionCwd && (p === sessionCwd || p.startsWith(sessionCwd + '/'))) return true;
  return ALLOWED_PREFIXES.some(prefix => p === prefix || p.startsWith(prefix + '/'));
}

// cwd allowlist for newly-spawned sessions; mirrors pathAllowed.
function cwdAllowed(cwd) {
  if (NO_DIR_PRIVACY) return true;
  if (!cwd) return false;
  const root = process.cwd();
  if (cwd === root || cwd.startsWith(root + '/')) return true;
  return ALLOWED_PREFIXES.some(prefix => cwd === prefix || cwd.startsWith(prefix + '/'));
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
  const logOut = execFileSync('git', ['log', '--format=%H|%s|%aI|%an', '-50'], { cwd: sessionCwd }).toString().trim();
  const commits = logOut ? logOut.split('\n').map(line => {
    const [hash, subject, date, author] = line.split('|');
    return { hash: hash?.slice(0, 7), subject, date, author };
  }) : [];
  let branch = null;
  try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: sessionCwd }).toString().trim(); } catch {}
  log('info', 'get_git_log', { commits: commits.length, branch });
  return { commits, branch };
});

rpc.register('get_git_status', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  if (!sessionCwd) throw new Error('no cwd for session');
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: sessionCwd }).toString();
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
  let diff = execFileSync('git', ['diff', 'HEAD', '--', msg.path], { cwd: sessionCwd, maxBuffer: MAX + 1 }).toString();
  if (!diff.trim()) diff = execFileSync('git', ['diff', '--cached', '--', msg.path], { cwd: sessionCwd, maxBuffer: MAX + 1 }).toString();
  log('info', 'get_git_file_diff', { path: msg.path, size: diff.length });
  return { diff: diff.slice(0, MAX) };
});

rpc.register('get_git_diff', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  if (!sessionCwd) throw new Error('no cwd for session');
  const MAX = 256 * 1024;
  if (!msg.commit || !/^[0-9a-f]{4,40}$/.test(msg.commit)) throw new Error('invalid commit hash');
  const diff = execFileSync('git', ['show', '--unified=3', msg.commit], { cwd: sessionCwd, maxBuffer: MAX + 1 }).toString();
  const statOut = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--numstat', msg.commit], { cwd: sessionCwd }).toString().trim();
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
  await authKeyReady;
  const ok = await hmacVerify(authKey, nonce, response);
  if (!ok) throw new Error('authentication failed');
  const token = await new SignJWT({ username })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .setAudience('codette-chat')  // MUST match server/src/chat-auth.js CHAT_AUD
    .setIssuer(`host:${HOST_JKT}`)
    .sign(HOST_PRIV_KEY_JOSE);
  await encKeyReady;
  log('info', 'auth_verify ok, token issued', { username });
  return { token };
});

// ── Server connection ─────────────────────────────────────────────────────────
let ws;

// One-shot version check against the server's served host package. Silent on
// any failure (network, JSON, missing field) — never blocks startup.
let versionChecked = false;
async function checkUpdate() {
  if (versionChecked) return;
  versionChecked = true;
  try {
    const httpUrl = SERVER_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const r = await fetch(`${httpUrl}/version`);
    if (!r.ok) return;
    const { host: latest } = await r.json();
    if (latest && latest !== HOST_VERSION) {
      w(`${A.yellow}update available: v${HOST_VERSION} → v${latest}${A.reset}  ${A.dim}run: codette update${A.reset}\n`);
    }
  } catch {}
}

async function connect() {
  const serverHttp = SERVER_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  let proof;
  try {
    proof = await signHandshakeProof({
      keyFilePath: HOST_KEY_PATH,
      aud:         serverHttp + '/host',
    });
  } catch (e) {
    log('error', 'failed to sign handshake proof', { err: e.message });
    setTimeout(connect, 3000);
    return;
  }
  ws = new WebSocket(`${SERVER_URL}/host?proof=${encodeURIComponent(proof)}&clientUsername=${encodeURIComponent(CLIENT_USERNAME)}`);

  ws.on('open', () => {
    hr();
    w(`${A.bold}${A.cyan}Claude Web Host${A.reset}  ${A.gray}${SERVER_URL}${A.reset}\n`);
    w(`${A.dim}Serving clients as: ${A.reset}${A.bold}${CLIENT_USERNAME}${A.reset}\n`);
    if (_passwordFromCreds) w(`${A.dim}credentials: ${A.reset}${CREDS_PATH}\n`);
    if (NO_DIR_PRIVACY) w(`${A.yellow}[warn] --no-dir-privacy: file access unrestricted${A.reset}\n`);
    hr();
    log('info', 'host connected to server', { url: SERVER_URL });
    // Register public key so server can verify client JWTs
    ws.send(JSON.stringify({ type: 'host_pubkey', pubkey: HOST_PUB_KEY }));
    // Re-announce agent states in one batch so server map is correct after reconnect/restart
    const states = {};
    for (const [sessionId, session] of agents) {
      if (sessionId) states[sessionId] = session.streaming ? 'streaming' : 'idle';
    }
    if (Object.keys(states).length > 0) hostSend({ type: 'agent_event', states });
    checkUpdate();
  });

  ws.on('message', async (data) => {
    const raw = data.toString();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Per-field decrypt: nonce+ciphertext → inner JSON merged onto outer routing fields.
    let wasDecrypted = false;
    if (msg?.nonce && msg?.ciphertext && encKey) {
      try {
        const inner = JSON.parse(await decrypt(encKey, msg.nonce, msg.ciphertext));
        const { nonce: _, ciphertext: __, ...outer } = msg;
        msg = { ...outer, ...inner };
        wasDecrypted = true;
        trace({ ts: Date.now(), src: 'server', dst: 'host', e2e: 'decrypted', type: msg.type });
      } catch (e) {
        process.stderr.write('e2e decrypt failed: ' + e.message + '\n');
        return;
      }
    } else if (msg?.type && msg.type !== 'log') {
      trace({ ts: Date.now(), src: 'server', dst: 'host', type: msg.type });
    }

    if (encKey && !wasDecrypted && E2E_REQUIRED_TYPES.has(msg?.type)) {
      log('warn', 'rejecting plaintext message under e2e', { type: msg?.type });
      return;
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

    if (msg.type === 'agent_ctl') {
      const { sessionId, event } = msg;
      const session = agents.get(sessionId);
      if (!session) {
        log('warn', 'agent_ctl: no agent for session', { sessionId: String(sessionId).slice(0, 8), event });
        return;
      }
      if (event === 'stop') {
        log('info', 'stopping agent', { sessionId: String(sessionId).slice(0, 8) });
        session.stop();
      } else if (event === 'interrupt') {
        log('info', 'interrupting agent', { sessionId: String(sessionId).slice(0, 8) });
        session.interrupt();
      } else {
        log('warn', 'agent_ctl: unknown event', { event });
      }
      return;
    }

    if (msg.type === 'permission_response') {
      const { toolUseId, allow, message: denyMsg, updatedInput } = msg;
      log('info', 'permission response', { toolUseId, allow });
      const pending = pendingPermissions.get(toolUseId);
      if (!pending) {
        log('warn', 'permission_response: no pending request', { toolUseId });
        return;
      }
      pendingPermissions.delete(toolUseId);
      // SDK replaces (not merges) input with updatedInput, so we must
      // spread the original input and layer the client's partial update on top.
      const mergedInput = updatedInput
        ? { ...pending.input, ...updatedInput }
        : pending.input;
      const result = allow
        ? { behavior: 'allow', updatedInput: mergedInput }
        : { behavior: 'deny', message: denyMsg || 'denied by user' };
      log('info', 'resolving permission', { toolUseId, behavior: result.behavior });
      pending.handler.resolve(result);
      return;
    }

    if (msg.type === 'user') {
      const { sessionId, message } = msg;
      if (!sessionId || !message) {
        log('warn', 'user message missing sessionId or message');
        return;
      }

      w(`\n${A.bold}${A.blue}you${A.reset}  ${message.content}\n`);
      log('info', 'user message → stdin', { preview: String(message.content).slice(0, 60), session: String(sessionId).slice(0, 8) });

      const echoLine = JSON.stringify({ type: 'user', message });

      // ── New session: spawn fresh Claude ────────────────────────────────────
      if (sessionId === '__new__') {
        const cwd = msg.cwd || null;
        const settings = msg.codette_settings ?? {};
        if (cwd) {
          if (!cwdAllowed(cwd)) {
            log('error', 'new_session: cwd outside allowed root', { cwd, root: process.cwd(), allowed: ALLOWED_PREFIXES });
            return;
          }
          try { statSync(cwd); } catch {
            log('error', 'new_session: cwd does not exist', { cwd });
            return;
          }
        }
        const extraArgs = [];
        if (settings.inlineFiles !== false)
          extraArgs.push('--append-system-prompt', makeInlineFilePrompt(cwd));
        if (settings.htmlRender !== false)
          extraArgs.push('--append-system-prompt', HTML_RENDER_PROMPT);
        const session = startSession(extraArgs, null, cwd);
        // Defer echo until system.init provides the real sessionId
        session.pendingEcho = echoLine;
        setImmediate(() => {
          session.send({ type: 'user', message });
        });
        return;
      }

      // ── Existing session ───────────────────────────────────────────────────
      const sendEcho = () => hostSend({ type: 'claude_line', sessionId, line: echoLine });

      let session = agents.get(sessionId);
      if (!session) {
        // No running agent — auto-resume this session then write message
        log('info', 'no agent for session, auto-resuming', { sessionId: String(sessionId).slice(0, 8) });
        session = startSession(['--resume', sessionId], sessionId);
        // Write after a tick so the process has started; echo after write
        setImmediate(() => {
          session.send(msg);
          sendEcho();
        });
      } else {
        session.send(msg);
        sendEcho();
      }
      return;
    }
  });

  ws.on('close', () => {
    log('warn', 'disconnected from server, reconnecting…');
    setTimeout(() => connect().catch(e => log('error', 'reconnect failed', { err: e.message })), 3000);
  });

  ws.on('error', (e) => log('error', `ws error: ${e.message}`));
}

connect().catch(e => { log('error', 'connect failed', { err: e.message }); process.exit(1); });

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
  for (const [, session] of agents) session.stop();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
