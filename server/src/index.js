// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { RpcClient } from './rpc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST_KEY   = process.env.HOST_KEY   || 'host-key-change-me';

const PORT       = parseInt(process.env.PORT || '3000', 10);

// ── Log buffer ────────────────────────────────────────────────────────────────
const LOG_MAX   = 500;
const logBuffer = [];

function appendLog(entry) {
  logBuffer.push({ ...entry, serverTs: Date.now() });
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
}

// ── Per-host state ────────────────────────────────────────────────────────────
class HostContext {
  constructor(clientUsername, ws) {
    this.clientUsername = clientUsername;
    this.ws = ws;
    this.pubkey = null;               // set when host sends host_pubkey
    this.sessionCache = [];
    this.hostCwd = null;
    this.pendingHistory = new Map();  // key → entry[]  (coalescing + retry)
    this.pendingDelete  = new Map();  // sessionId → res
    this.rpc = new RpcClient();
  }

  broadcast(msg) {
    if (msg.type !== 'log') wtrace('server', 'client', msg.type, { sessionId: msg.sessionId?.slice(0, 8) ?? null });
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
app.use(express.json());

// ── REST request logging ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      const data = { method: req.method, path: req.path, status: res.statusCode };
      const sessionMatch = req.path.match(/\/sessions\/([^/]+)/);
      if (sessionMatch) data.sessionId = sessionMatch[1].slice(0, 8);
      if (Object.keys(req.query).length) data.query = req.query;
      appendLog({ level: 'info', msg: 'rest', data });
      const qs = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
      console.log('[rest]', data.method, data.path + qs, data.status, data.sessionId ?? '');
    }
  });
  next();
});

const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

// ── Trace helper ──────────────────────────────────────────────────────────────
const wtrace = (src, dst, type, meta = {}) =>
  process.stdout.write('TRACE ' + JSON.stringify({ ts: Date.now(), src, dst, type, ...meta }) + '\n');

// ── Cookie helper ─────────────────────────────────────────────────────────────
function getCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireJwt(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
  const username = getCookie(req, 'username') ?? req.query.username;
  const host = hosts.get(username);
  if (!host?.pubkey) return res.status(503).json({ error: 'Host not connected' });
  try { req.user = jwt.verify(token, host.pubkey, { algorithms: ['ES256'] }); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
}

function requireHost(req, res, next) {
  const host = hosts.get(req.user.username);
  if (!host) return res.status(503).json({ error: 'Host not connected' });
  req.claudeHost = host;
  next();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/challenge', (req, res) => {
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

app.post('/api/auth/verify', (req, res) => {
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
      res.setHeader('Set-Cookie', `username=${encodeURIComponent(username)}; Path=/; HttpOnly; SameSite=Strict`);
      res.json(result);
    },
    10000);
  res.on('close', () => host.rpc.cancel(rid));
});

// ── Sessions list ─────────────────────────────────────────────────────────────
app.get('/api/sessions', requireJwt, (req, res) => {
  const host = hosts.get(req.user.username);
  res.json({ sessions: host?.sessionCache ?? [], hostCwd: host?.hostCwd ?? null });
});

// ── Session history ───────────────────────────────────────────────────────────
app.get('/api/sessions/:id/history', requireJwt, requireHost, (req, res) => {
  const host = req.claudeHost;
  const id = req.params.id;
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : null;
  const limit  = req.query.limit  !== undefined ? Number(req.query.limit)  : null;
  const key = `${id}:${offset ?? ''}:${limit ?? ''}`;

  const timer = setTimeout(() => {
    const pending = host.pendingHistory.get(key);
    if (pending) {
      const idx = pending.findIndex(e => e.res === res);
      if (idx !== -1) pending.splice(idx, 1);
      if (pending.length === 0) host.pendingHistory.delete(key);
    }
    if (!res.headersSent) res.status(504).json({ error: 'History request timed out' });
  }, 30000);

  res.on('close', () => clearTimeout(timer));

  const entry = { res, incremental: offset !== null && offset > 0, offset, limit };

  if (host.pendingHistory.has(key)) {
    host.pendingHistory.get(key).push(entry);
  } else {
    host.pendingHistory.set(key, [entry]);
    if (host.ws.readyState === WebSocket.OPEN) {
      wtrace('server', 'host', 'get_session_history', { sessionId: id.slice(0, 8) });
      host.ws.send(JSON.stringify({
        type: 'get_session_history',
        sessionId: id,
        offset: offset != null ? offset : undefined,
        limit: limit ?? undefined,
      }));
    }
  }
});

// ── File system listing ───────────────────────────────────────────────────────
app.get('/api/sessions/:id/fs', requireJwt, requireHost, (req, res) => {
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_fs',
    { sessionId: req.params.id, path: req.query.path ?? null },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); },
    10000);
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── File content ──────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/file', requireJwt, requireHost, (req, res) => {
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_file',
    { sessionId: req.params.id, path: req.query.path },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); },
    10000);
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Git log ───────────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/log', requireJwt, requireHost, (req, res) => {
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_git_log',
    { sessionId: req.params.id },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Git status ────────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/status', requireJwt, requireHost, (req, res) => {
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_git_status',
    { sessionId: req.params.id },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Git diff ──────────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/diff', requireJwt, requireHost, (req, res) => {
  const commit = req.query.commit;
  if (!commit) return res.status(400).json({ error: 'commit required' });
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_git_diff',
    { sessionId: req.params.id, commit },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Git file diff ─────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/file-diff', requireJwt, requireHost, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_git_file_diff',
    { sessionId: req.params.id, path: filePath },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Session name ──────────────────────────────────────────────────────────────
app.put('/api/sessions/:id/name', requireJwt, requireHost, (req, res) => {
  const { name } = req.body || {};
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'set_session_name',
    { sessionId: req.params.id, name: name || null },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Create session ────────────────────────────────────────────────────────────
app.post('/api/sessions', requireJwt, requireHost, (req, res) => {
  const { cwd, firstMessage, claudeweb_settings } = req.body || {};
  wtrace('server', 'host', 'new_session');
  req.claudeHost.ws.send(JSON.stringify({ type: 'new_session', cwd, firstMessage, claudeweb_settings }));
  res.status(202).json({});
});

// ── Delete session ────────────────────────────────────────────────────────────
app.delete('/api/sessions/:id', requireJwt, requireHost, (req, res) => {
  const host = req.claudeHost;
  const id = req.params.id;
  host.pendingDelete.set(id, res);
  wtrace('server', 'host', 'delete_session', { sessionId: id.slice(0, 8) });
  host.ws.send(JSON.stringify({ type: 'delete_session', sessionId: id }));

  const timer = setTimeout(() => {
    if (host.pendingDelete.get(id) === res) {
      host.pendingDelete.delete(id);
      if (!res.headersSent) res.status(504).json({ error: 'Delete timed out' });
    }
  }, 30000);
  res.on('close', () => clearTimeout(timer));
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const key = req.query.key || req.headers['x-host-key'];
  const validKey = process.env.HOST_KEY || 'host-key-change-me';
  if (key !== validKey) return res.status(401).json({ error: 'Unauthorized' });
  if (req.query.fmt === 'text') {
    const text = logBuffer.map(e => {
      const d = new Date(e.serverTs ?? e.ts ?? 0).toISOString();
      const data = e.data ? ' ' + JSON.stringify(e.data) : '';
      return `${d} [${e.level}] ${e.msg}${data}`;
    }).join('\n');
    return res.type('text/plain').send(text);
  }
  res.json(logBuffer);
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));

// ── WebSocket server ──────────────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');

  // ── Host connection ────────────────────────────────────────────────────────
  if (url.pathname === '/host') {
    if (url.searchParams.get('token') !== HOST_KEY) { ws.close(1008, 'Unauthorized'); return; }
    const clientUsername = url.searchParams.get('clientUsername');
    if (!clientUsername) { ws.close(1008, 'clientUsername required'); return; }
    if (hosts.has(clientUsername)) { ws.close(1008, 'Host already connected for this username'); return; }

    const host = new HostContext(clientUsername, ws);
    hosts.set(clientUsername, host);
    console.log(`[server] host connected: ${clientUsername} (${hosts.size} total)`);
    wtrace('host', 'server', 'connect', { username: clientUsername });

    wtrace('server', 'host', 'list_sessions', { username: clientUsername });
    ws.send(JSON.stringify({ type: 'list_sessions' }));
    host.broadcast({ type: 'host_status', connected: true });

    // Re-send pending history requests that arrived while host was down
    for (const [key, entries] of host.pendingHistory) {
      if (entries.length === 0) continue;
      const { offset, limit } = entries[0];
      const sessionId = key.split(':')[0];
      ws.send(JSON.stringify({
        type: 'get_session_history',
        sessionId,
        offset: offset != null ? offset : undefined,
        limit: limit ?? undefined,
      }));
    }

    ws.on('message', (data) => {
      let ev;
      try { ev = JSON.parse(data.toString()); } catch {}

      if (host.rpc.handle(ev)) return;

      if (ev?.type === 'host_pubkey') {
        wtrace('host', 'server', 'host_pubkey');
        host.pubkey = ev.pubkey;
        console.log(`[server] host pubkey registered: ${clientUsername}`);
        return;
      }

      if (ev?.type === 'log') {
        appendLog(ev);
        const extra = ev.data ? ' ' + JSON.stringify(ev.data) : '';
        console.log(`[${clientUsername}][${ev.level}] ${ev.msg}${extra}`);
        return;
      }

      if (ev?.type === 'claude_line') {
        wtrace('host', 'server', 'claude_line', { sessionId: ev.sessionId?.slice(0, 8) ?? null });
        host.broadcast({ type: 'claude_line', sessionId: ev.sessionId, line: ev.line });

        return;
      }

      if (ev?.type === 'agent_event') {
        wtrace('host', 'server', 'agent_event', { sessionId: ev.sessionId?.slice(0, 8) ?? null });
        if (ev.states) {
          host.broadcast({ type: 'agent_event', states: ev.states });
        } else {
          const { sessionId, event } = ev;
          appendLog({ level: 'info', msg: 'agent_event', data: { sessionId: String(sessionId).slice(0, 8), event } });
          host.broadcast({ type: 'agent_event', sessionId, event });
        }
        return;
      }

      if (ev?.type === 'session_list') {
        wtrace('host', 'server', 'session_list');
        host.sessionCache = ev.sessions || [];
        if (ev.hostCwd) host.hostCwd = ev.hostCwd;
        host.broadcast({ type: 'session_list', sessions: host.sessionCache, hostCwd: host.hostCwd });
        const remainingIds = new Set(host.sessionCache.map(s => s.id));
        for (const [sessionId, res] of host.pendingDelete) {
          if (!remainingIds.has(sessionId)) {
            if (!res.headersSent) res.status(204).send();
            host.pendingDelete.delete(sessionId);
          }
        }
        return;
      }

      if (ev?.type === 'history') {
        wtrace('host', 'server', 'history', { sessionId: ev.sessionId?.slice(0, 8) ?? null });
        const { sessionId, lines, totalLines, reqOffset, reqLimit } = ev;
        const key = `${sessionId}:${reqOffset ?? ''}:${reqLimit ?? ''}`;
        const pending = host.pendingHistory.get(key);
        if (pending) {
          for (const { res, incremental } of pending) {
            if (!res.headersSent) res.json({ lines, incremental, totalLines });
          }
          host.pendingHistory.delete(key);
        }
        return;
      }
    });

    ws.on('close', () => {
      hosts.delete(clientUsername);
      host.rpc.flush();
      console.log(`[server] host disconnected: ${clientUsername} (${hosts.size} remaining)`);
      wtrace('host', 'server', 'disconnect', { username: clientUsername });
      host.broadcast({ type: 'host_status', connected: false });
    });
    ws.on('error', (e) => console.error(`[server] host error (${clientUsername}):`, e.message));

  // ── Client connection ──────────────────────────────────────────────────────
  } else if (url.pathname === '/ws') {
    const token = url.searchParams.get('token');
    const username = getCookie(req, 'username') ?? url.searchParams.get('username');
    const host = hosts.get(username);
    let user;
    try {
      if (!host?.pubkey) throw new Error('Host not connected');
      user = jwt.verify(token, host.pubkey, { algorithms: ['ES256'] });
    } catch { ws.close(1008, 'Unauthorized'); return; }

    const { username: verifiedUsername } = user;
    if (!clients.has(verifiedUsername)) clients.set(verifiedUsername, new Set());
    clients.get(verifiedUsername).add(ws);

    ws.send(JSON.stringify({ type: 'host_status', connected: !!host }));
    if (host) {
      ws.send(JSON.stringify({ type: 'session_list', sessions: host.sessionCache, hostCwd: host.hostCwd }));
    }
    console.log(`[server] client connected: ${verifiedUsername} (${clients.get(verifiedUsername).size} for user)`);
    wtrace('client', 'server', 'connect', { username: verifiedUsername });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      wtrace('client', 'server', msg.type, { sessionId: msg.sessionId?.slice(0, 8) ?? null });
      const logData = { type: msg.type, username: verifiedUsername };
      if (msg.sessionId) logData.sessionId = String(msg.sessionId).slice(0, 8);
      appendLog({ level: 'info', msg: 'client→server', data: logData });

      const h = hosts.get(verifiedUsername);
      if (h?.ws.readyState === WebSocket.OPEN) {
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
