// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { importSPKI } from 'jose';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import cookieParser from 'cookie-parser';
import { RpcClient } from './rpc.js';
import { unpackParam } from '../../shared/crypto.js';
import { mountHostEnrollmentRoutes, pendingStore } from './host-enrollment/register.js';
import { verifyIdToken, mountConsentRoute } from './user-auth/index.js';
import { renderError } from './util/render.js';
import { lookupByPubkey } from './host-enrollment/owners.js';
import { verifyHandshakeProof } from './host-enrollment/ws-auth.js';
import { makeJtiCache } from './host-enrollment/jti-cache.js';
import { verifyChatJwt } from './chat-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3000', 10);

// Server issuer URL (used as iss in id_tokens and as expected audience root)
const SERVER_ISSUER = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// JTI cache for WS handshake proofs (separate from registration jti cache)
const wsJtiCache = makeJtiCache();

// ── Per-host state ────────────────────────────────────────────────────────────
class HostContext {
  constructor(clientUsername, ws) {
    this.clientUsername = clientUsername;
    this.ws = ws;
    this.pubkey = null;               // set when host sends host_pubkey
    this.sessionCache = [];
    this.hostCwd = null;
    this.sessionListResponse = null;  // cached REST response (plaintext or encrypted)
    this.pendingDelete  = new Map();  // sessionId → res
    this.rpc = new RpcClient();
  }

  broadcast(msg) {
    wtrace('server', 'client', msg.type, { sessionId: msg.sessionId?.slice(0, 8) ?? null });
    const data = JSON.stringify(msg);
    for (const ws of clients.get(this.clientUsername) ?? []) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }
}

// ── Server state ──────────────────────────────────────────────────────────────
const hosts   = new Map();  // username → HostContext
const clients = new Map();  // username → Set<WebSocket>

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(cookieParser());

// ── host-enrollment registration routes ───────────────────────────────────────
mountHostEnrollmentRoutes(app, { serverIssuer: SERVER_ISSUER, verifyIdToken });
mountConsentRoute(app, { serverIssuer: SERVER_ISSUER, pendingStore, renderError });

// ── REST request logging ──────────────────────────────────────────────────────
// Query params that are bearer-credential-shaped and must never appear in logs.
const REDACTED_QS_KEYS = new Set(['token', 'access_token', 'auth', 'host_proof', 'id_token']);
app.use((req, res, next) => {
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      const sessionMatch = req.path.match(/\/sessions\/([^/]+)/);
      const sessionId = sessionMatch ? sessionMatch[1].slice(0, 8) : '';
      const params = new URLSearchParams(req.query);
      for (const key of REDACTED_QS_KEYS) {
        if (params.has(key)) params.set(key, '[redacted]');
      }
      const qs = params.toString() ? '?' + params.toString() : '';
      console.log('[rest]', req.method, req.path + qs, res.statusCode, sessionId);
    }
  });
  next();
});

const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

// ── Trace helper ──────────────────────────────────────────────────────────────
const TRACE = process.env.CODETTE_TRACE === '1';
const wtrace = (src, dst, type, meta = {}) => {
  if (TRACE) process.stdout.write('TRACE ' + JSON.stringify({ ts: Date.now(), src, dst, type, ...meta }) + '\n');
};

// ── Cookie helper ─────────────────────────────────────────────────────────────
function getCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
// The JWT is the trust anchor: host-issued, signed by that host's private key.
// We peek at the unverified payload only to look up which host's pubkey to
// verify against, then verify the signature. The cookie/query channel that
// previously carried `username` is no longer required — REST and WS both
// derive the routing identity from the JWT itself.
function unsafeDecodeJwtUsername(token) {
  try {
    const [, payloadB64] = String(token).split('.');
    if (!payloadB64) return null;
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    return JSON.parse(json).username ?? null;
  } catch { return null; }
}

async function requireJwt(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  const claimedUsername = unsafeDecodeJwtUsername(token);
  if (!claimedUsername) return res.status(401).json({ error: 'Unauthorized' });
  const host = hosts.get(claimedUsername);
  if (!host?.pubkeyKey) return res.status(503).json({ error: 'Host not connected' });
  // verifyChatJwt enforces aud + iss + signature. payload.username equals
  // claimedUsername by construction (both come from the same JWT).
  const payload = await verifyChatJwt(token, host);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.user = payload;
  next();
}

function requireHost(req, res, next) {
  const host = hosts.get(req.user.username);
  if (!host) return res.status(503).json({ error: 'Host not connected' });
  req.claudeHost = host;
  next();
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
function makeRateLimit(label, windowMs, max) {
  const attempts = new Map(); // ip → { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of attempts) {
      if (now > entry.resetAt) attempts.delete(ip);
    }
  }, windowMs).unref();
  return function rateLimit(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    let entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      attempts.set(ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Rate limit exceeded (${label})` });
    }
    next();
  };
}

const apiLimiter       = makeRateLimit('api',       60_000, 600);
const expensiveLimiter = makeRateLimit('expensive', 60_000, 60);
const tarballLimiter   = makeRateLimit('tarball',   60_000, 5);

app.use('/api', apiLimiter);
app.use('/host.tar.gz', tarballLimiter);

// ── Auth ──────────────────────────────────────────────────────────────────────
const authRateLimit = makeRateLimit('auth', 60_000, 10);

app.post('/api/auth/challenge', authRateLimit, (req, res) => {
  const { username } = req.body || {};
  wtrace('client', 'server', 'auth_challenge');
  const host = hosts.get(username);
  if (!host) return res.status(503).json({ error: 'Host not connected' });
  wtrace('server', 'host', 'auth_challenge');
  const rid = host.rpc.call(host.ws, 'auth_challenge', { username },
    (err, result) => { wtrace('host', 'server', 'auth_challenge'); if (!res.headersSent) err ? res.status(401).json({ error: err.message }) : res.json(result); },
    10000);
  res.on('close', () => host.rpc.cancel(rid));
});

app.post('/api/auth/verify', authRateLimit, (req, res) => {
  const { username, nonce, response } = req.body || {};
  wtrace('client', 'server', 'auth_verify');
  const host = hosts.get(username);
  if (!host) return res.status(503).json({ error: 'Host not connected' });
  wtrace('server', 'host', 'auth_verify');
  const rid = host.rpc.call(host.ws, 'auth_verify', { username, nonce, response },
    (err, result) => {
      wtrace('host', 'server', 'auth_verify');
      if (res.headersSent) return;
      if (err) return res.status(401).json({ error: err.message });
      const secure = req.secure ? '; Secure' : '';
      res.setHeader('Set-Cookie', `username=${encodeURIComponent(username)}; Path=/; SameSite=Strict${secure}`);
      res.json(result);
    },
    10000);
  res.on('close', () => host.rpc.cancel(rid));
});

// ── Sessions list ─────────────────────────────────────────────────────────────
app.get('/api/sessions', requireJwt, (req, res) => {
  const host = hosts.get(req.user.username);
  res.json(host?.sessionListResponse ?? { sessions: [], hostCwd: null });
});

// ── Session history ───────────────────────────────────────────────────────────
app.get('/api/sessions/:id/history', expensiveLimiter, requireJwt, requireHost, (req, res) => {
  const host = req.claudeHost;
  const id = req.params.id;
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : null;
  const limit  = req.query.limit  !== undefined ? Number(req.query.limit)  : null;
  const incremental = offset !== null && offset > 0;
  const rid = host.rpc.call(host.ws, 'get_session_history',
    { sessionId: id, offset: offset != null ? offset : undefined, limit: limit ?? undefined },
    (err, result) => {
      if (res.headersSent) return;
      if (err) return res.status(504).json({ error: err.message });
      res.json({ ...result, incremental });
    }, 30000);
  res.on('close', () => host.rpc.cancel(rid));
});

// ── File system listing ───────────────────────────────────────────────────────
app.get('/api/sessions/:id/fs', expensiveLimiter, requireJwt, requireHost, (req, res) => {
  const encPath = req.query.enc_path;
  const payload = encPath
    ? { sessionId: req.params.id, ...unpackParam(encPath) }
    : { sessionId: req.params.id, path: req.query.path ?? null };
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_fs', payload,
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); },
    10000);
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── File content ──────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/file', expensiveLimiter, requireJwt, requireHost, (req, res) => {
  const encPath = req.query.enc_path;
  const payload = encPath
    ? { sessionId: req.params.id, ...unpackParam(encPath) }
    : { sessionId: req.params.id, path: req.query.path };
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_file', payload,
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); },
    10000);
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Git log ───────────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/log', expensiveLimiter, requireJwt, requireHost, (req, res) => {
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_git_log',
    { sessionId: req.params.id },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Git status ────────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/status', expensiveLimiter, requireJwt, requireHost, (req, res) => {
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_git_status',
    { sessionId: req.params.id },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Git diff ──────────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/diff', expensiveLimiter, requireJwt, requireHost, (req, res) => {
  const commit = req.query.commit;
  if (!commit) return res.status(400).json({ error: 'commit required' });
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_git_diff',
    { sessionId: req.params.id, commit },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Git file diff ─────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/file-diff', expensiveLimiter, requireJwt, requireHost, (req, res) => {
  const encPath = req.query.enc_path;
  if (encPath) {
    const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_git_file_diff',
      { sessionId: req.params.id, ...unpackParam(encPath) },
      (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
    res.on('close', () => req.claudeHost.rpc.cancel(rid));
    return;
  }
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_git_file_diff',
    { sessionId: req.params.id, path: filePath },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Session name ──────────────────────────────────────────────────────────────
app.put('/api/sessions/:id/name', requireJwt, requireHost, (req, res) => {
  const { enc, name } = req.body || {};
  const params = enc
    ? { sessionId: req.params.id, ...unpackParam(enc) }
    : { sessionId: req.params.id, name: name || null };
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'set_session_name', params,
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Delete session ────────────────────────────────────────────────────────────
app.delete('/api/sessions/:id', requireJwt, requireHost, (req, res) => {
  const host = req.claudeHost;
  const id = req.params.id;
  const enc = req.query.enc;
  const wireMsg = enc
    ? { type: 'delete_session', sessionId: id, ...unpackParam(enc) }
    : { type: 'delete_session', sessionId: id };
  host.pendingDelete.set(id, res);
  wtrace('server', 'host', 'delete_session', { sessionId: id.slice(0, 8) });
  host.ws.send(JSON.stringify(wireMsg));

  const timer = setTimeout(() => {
    if (host.pendingDelete.get(id) === res) {
      host.pendingDelete.delete(id);
      if (!res.headersSent) res.status(504).json({ error: 'Delete timed out' });
    }
  }, 30000);
  res.on('close', () => clearTimeout(timer));
});

// ── Install script ───────────────────────────────────────────────────────────
const installShPath = path.resolve(__dirname, '../../install.sh');
app.get('/install.sh', (req, res) => {
  const hostname = process.env.SERVER_HOSTNAME;
  if (!hostname) {
    return res.status(503).type('text/plain')
      .send('# SERVER_HOSTNAME not configured on server. Set it in .env before serving installs.\n');
  }
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(hostname);
  const wsProto = isLocal ? 'ws' : 'wss';
  const serverUrl = `${wsProto}://${hostname}`;
  let script = readFileSync(installShPath, 'utf8');
  script = script.replace('SERVER_URL="${CODETTE_SERVER_URL:-}"', `SERVER_URL="${serverUrl}"`);
  res.type('text/plain').send(script);
});

// ── Host tarball (fallback when git/GitHub unavailable) ──────────────────────
const appRoot = path.resolve(__dirname, '../..');
const hostDir = path.join(appRoot, 'host');
if (existsSync(hostDir)) {
  const hostPkgVersion = JSON.parse(
    readFileSync(path.join(hostDir, 'package.json'), 'utf8')
  ).version;
  app.get('/version', (_req, res) => res.json({ host: hostPkgVersion }));
  app.get('/host.tar.gz', tarballLimiter, (_req, res) => {
    try {
      const tar = execFileSync('tar', [
        'czf', '-', '-C', appRoot, 'host', 'shared',
      ], { maxBuffer: 10 * 1024 * 1024 });
      res.type('application/gzip').send(tar);
    } catch (e) {
      res.status(500).json({ error: 'Failed to create tarball' });
    }
  });
}

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get(/.*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));

// ── WebSocket server ──────────────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');

  // ── Host connection ────────────────────────────────────────────────────────
  if (url.pathname === '/host') {
    const proof = url.searchParams.get('proof');
    const clientUsername = url.searchParams.get('clientUsername');

    // Validate via host-enrollment handshake proof
    const validated = await verifyHandshakeProof({
      proofJwt:      proof,
      lookupByPubkey,
      expectedAud:   SERVER_ISSUER + '/host',
      jtiCache:      wsJtiCache,
    });

    if (!validated) {
      ws.close(1008, 'Unauthorized');
      return;
    }
    if (!clientUsername) {
      ws.close(1008, 'clientUsername required');
      return;
    }
    if (clientUsername !== validated.username) {
      ws.close(1008, 'clientUsername mismatch');
      return;
    }
    if (hosts.has(validated.username)) {
      ws.close(1008, 'Host already connected for this username');
      return;
    }

    const host = new HostContext(validated.username, ws);
    host.jkt = validated.jkt;
    hosts.set(validated.username, host);
    console.log(`[server] host connected: ${validated.username} (${hosts.size} total)`);
    wtrace('host', 'server', 'connect', { username: validated.username });

    host.broadcast({ type: 'host_status', connected: true });

    ws.on('message', (data) => {
      let ev;
      try { ev = JSON.parse(data.toString()); } catch {}

      if (host.rpc.handle(ev)) return;

      if (ev?.type === 'host_pubkey') {
        wtrace('host', 'server', 'host_pubkey');
        host.pubkey = ev.pubkey;
        host.pubkeyKey = importSPKI(ev.pubkey, 'ES256');
        host.pubkeyKey.catch(e => console.error(`[server] host pubkey import failed (${validated.username}):`, e.message));
        console.log(`[server] host pubkey registered: ${validated.username}`);
        return;
      }

      if (ev?.type === 'claude_line') {
        wtrace('host', 'server', 'claude_line');
        host.broadcast(ev);
        wtrace('server', 'client', 'claude_line', { sessionId: ev.sessionId?.slice(0, 8) ?? null });
        return;
      }

      if (ev?.type === 'agent_event') {
        wtrace('host', 'server', 'agent_event', { sessionId: ev.sessionId?.slice(0, 8) ?? null });
        host.broadcast(ev);
        wtrace('server', 'client', 'agent_event', { sessionId: ev.sessionId?.slice(0, 8) ?? null });
        return;
      }

      if (ev?.type === 'permission_request') {
        host.broadcast(ev);
        return;
      }

      if (ev?.type === 'session_list') {
        wtrace('host', 'server', 'session_list');
        if (ev.ciphertext) {
          host.sessionListResponse = { nonce: ev.nonce, ciphertext: ev.ciphertext };
        } else {
          host.sessionCache = ev.sessions || [];
          if (ev.hostCwd) host.hostCwd = ev.hostCwd;
          host.sessionListResponse = { sessions: host.sessionCache, hostCwd: host.hostCwd };
        }
        host.broadcast(ev);
        wtrace('server', 'client', 'session_list', { sessionId: null });
        if (!ev.ciphertext) {
          const remainingIds = new Set(host.sessionCache.map(s => s.id));
          for (const [sessionId, res] of host.pendingDelete) {
            if (!remainingIds.has(sessionId)) {
              if (!res.headersSent) res.status(204).send();
              host.pendingDelete.delete(sessionId);
            }
          }
        }
        return;
      }
    });

    ws.on('close', () => {
      hosts.delete(validated.username);
      host.rpc.flush();
      console.log(`[server] host disconnected: ${validated.username} (${hosts.size} remaining)`);
      wtrace('host', 'server', 'disconnect', { username: validated.username });
      host.broadcast({ type: 'host_status', connected: false });
    });
    ws.on('error', (e) => console.error(`[server] host error (${validated.username}):`, e.message));

  // ── Client connection ──────────────────────────────────────────────────────
  } else if (url.pathname === '/ws') {
    // Same trust model as requireJwt: peek at the JWT payload to look up the
    // host's pubkey, then verify via verifyChatJwt (aud + iss + signature).
    // No cookie/query dependency.
    const token = url.searchParams.get('token');
    const claimedUsername = unsafeDecodeJwtUsername(token);
    const host = claimedUsername ? hosts.get(claimedUsername) : null;
    if (!claimedUsername || !host?.pubkeyKey) { ws.close(1008, 'Unauthorized'); return; }
    const user = await verifyChatJwt(token, host);
    if (!user) { ws.close(1008, 'Unauthorized'); return; }

    const { username: verifiedUsername } = user;
    if (!clients.has(verifiedUsername)) clients.set(verifiedUsername, new Set());
    clients.get(verifiedUsername).add(ws);

    ws.send(JSON.stringify({ type: 'host_status', connected: !!host }));
    console.log(`[server] client connected: ${verifiedUsername} (${clients.get(verifiedUsername).size} for user)`);
    wtrace('client', 'server', 'connect', { username: verifiedUsername });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      wtrace('client', 'server', msg.type, { sessionId: msg.sessionId?.slice(0, 8) ?? null });
      const h = hosts.get(verifiedUsername);
      if (h?.ws?.readyState === WebSocket.OPEN) {
        wtrace('server', 'host', msg.type, { sessionId: msg.sessionId?.slice(0, 8) ?? null });
        h.ws.send(data.toString());
      }
    });

    ws.on('close', () => {
      clients.get(verifiedUsername)?.delete(ws);
      wtrace('client', 'server', 'disconnect', { username: verifiedUsername });
      console.log(`[server] client disconnected: ${verifiedUsername} (${clients.get(verifiedUsername)?.size ?? 0} remaining)`);
    });
    ws.on('error', (e) => console.error(`[server] client error (${verifiedUsername}):`, e.message));

  } else {
    ws.close(1008, 'Unknown path');
  }
});

server.listen(PORT, () => console.log('[server] listening on port', PORT));
