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

// Strip thinking blocks from assistant lines — the browser never renders them
// and they can be hundreds of KB each.
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

const JWT_SECRET = process.env.JWT_SECRET || 'jwt-secret-change-me';
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
  constructor(clientUsername, clientPassword, ws) {
    this.clientUsername = clientUsername;
    this.clientPassword = clientPassword;
    this.ws = ws;
    this.agents = new Map();          // sessionId → { active, streaming }
    this.sessionCache = [];
    this.hostCwd = null;
    this.pendingHistory = new Map();  // sessionId → entry[]  (coalescing + retry)
    this.pendingDelete  = new Map();  // sessionId → res      (drained by session_list)
    this.rpc = new RpcClient();
  }

  enrichSessions() {
    return this.sessionCache.map(s => {
      const a = this.agents.get(s.id);
      const state = a?.active ? (a.streaming ? 'running' : 'idle') : null;
      return state ? { ...s, agentState: state } : s;
    });
  }

  broadcast(msg) {
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

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireJwt(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
}

function requireHost(req, res, next) {
  const host = hosts.get(req.user.username);  // keyed by clientUsername
  if (!host) return res.status(503).json({ error: 'Host not connected' });
  req.claudeHost = host;
  next();
}

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const host = [...hosts.values()].find(h => h.clientUsername === username && h.clientPassword === password);
  if (host) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// ── Sessions list ─────────────────────────────────────────────────────────────
app.get('/api/sessions', requireJwt, (req, res) => {
  const host = hosts.get(req.user.username);  // clientUsername from JWT
  res.json({ sessions: host ? host.enrichSessions() : [], hostCwd: host?.hostCwd ?? null });
});

// ── Session history ───────────────────────────────────────────────────────────
app.get('/api/sessions/:id/history', requireJwt, requireHost, (req, res) => {
  const host = req.claudeHost;
  const id = req.params.id;
  const offsetStr = req.query.offset;
  const offset = offsetStr !== undefined ? Number(offsetStr) : null;

  const timer = setTimeout(() => {
    const pending = host.pendingHistory.get(id);
    if (pending) {
      const idx = pending.findIndex(e => e.res === res);
      if (idx !== -1) pending.splice(idx, 1);
      if (pending.length === 0) host.pendingHistory.delete(id);
    }
    if (!res.headersSent) res.status(504).json({ error: 'History request timed out' });
  }, 30000);

  res.on('close', () => clearTimeout(timer));

  const entry = { res, incremental: offset !== null && offset > 0, offset };

  if (host.pendingHistory.has(id)) {
    host.pendingHistory.get(id).push(entry);
  } else {
    host.pendingHistory.set(id, [entry]);
    if (host.ws.readyState === WebSocket.OPEN) {
      host.ws.send(JSON.stringify({
        type: 'get_session_history',
        sessionId: id,
        offset: offset !== null && offset > 0 ? offset : undefined,
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

// ── Git diff ──────────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/diff', requireJwt, requireHost, (req, res) => {
  const commit = req.query.commit;
  if (!commit) return res.status(400).json({ error: 'commit required' });
  const rid = req.claudeHost.rpc.call(req.claudeHost.ws, 'get_git_diff',
    { sessionId: req.params.id, commit },
    (err, result) => { if (!res.headersSent) err ? res.status(504).json({ error: err.message }) : res.json(result); });
  res.on('close', () => req.claudeHost.rpc.cancel(rid));
});

// ── Create session ────────────────────────────────────────────────────────────
app.post('/api/sessions', requireJwt, requireHost, (req, res) => {
  const { cwd, firstMessage, claudeweb_settings } = req.body || {};
  req.claudeHost.ws.send(JSON.stringify({ type: 'new_session', cwd, firstMessage, claudeweb_settings }));
  res.status(202).json({});
});

// ── Delete session ────────────────────────────────────────────────────────────
app.delete('/api/sessions/:id', requireJwt, requireHost, (req, res) => {
  const host = req.claudeHost;
  const id = req.params.id;
  host.pendingDelete.set(id, res);
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
  // Accept any connected host's key or fall back to env var
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
    const clientPassword = url.searchParams.get('clientPassword');
    if (!clientUsername || !clientPassword) { ws.close(1008, 'clientUsername and clientPassword required'); return; }
    if (hosts.has(clientUsername)) { ws.close(1008, 'Host already connected for this username'); return; }

    const host = new HostContext(clientUsername, clientPassword, ws);
    hosts.set(clientUsername, host);
    console.log(`[server] host connected: ${clientUsername} (${hosts.size} total)`);

    ws.send(JSON.stringify({ type: 'list_sessions' }));
    host.broadcast({ type: 'host_status', connected: true });

    // Re-send pending history requests that arrived while host was down
    for (const [sessionId, entries] of host.pendingHistory) {
      if (entries.length === 0) continue;
      const { offset } = entries[0];
      ws.send(JSON.stringify({
        type: 'get_session_history',
        sessionId,
        offset: offset !== null && offset > 0 ? offset : undefined,
      }));
    }

    ws.on('message', (data) => {
      let ev;
      try { ev = JSON.parse(data.toString()); } catch {}

      if (host.rpc.handle(ev)) return;

      if (ev?.type === 'log') {
        appendLog(ev);
        const extra = ev.data ? ' ' + JSON.stringify(ev.data) : '';
        console.log(`[${clientUsername}][${ev.level}] ${ev.msg}${extra}`);
        return;
      }

      if (ev?.type === 'claude_line') {
        host.broadcast({ type: 'claude_line', sessionId: ev.sessionId, line: ev.line });
        return;
      }

      if (ev?.type === 'agent_event') {
        if (ev.states) {
          for (const [sessionId, event] of Object.entries(ev.states)) {
            host.agents.set(sessionId, {
              active: event === 'started' || event === 'streaming' || event === 'idle',
              streaming: event === 'streaming',
            });
          }
          host.broadcast({ type: 'agent_event', states: ev.states });
        } else {
          const { sessionId, event } = ev;
          host.agents.set(sessionId, {
            active: event === 'started' || event === 'streaming' || event === 'idle',
            streaming: event === 'streaming',
          });
          appendLog({ level: 'info', msg: 'agent_event', data: { sessionId: String(sessionId).slice(0, 8), event } });
          host.broadcast({ type: 'agent_event', sessionId, event });
        }
        return;
      }

      if (ev?.type === 'session_list') {
        host.sessionCache = ev.sessions || [];
        if (ev.hostCwd) host.hostCwd = ev.hostCwd;
        host.broadcast({ type: 'session_list', sessions: host.enrichSessions(), hostCwd: host.hostCwd });
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
        const { sessionId, lines, totalLines } = ev;
        const pending = host.pendingHistory.get(sessionId);
        if (pending) {
          for (const { res, incremental } of pending) {
            if (!res.headersSent) res.json({ lines: stripThinking(lines), incremental, totalLines });
          }
          host.pendingHistory.delete(sessionId);
        }
        return;
      }
    });

    ws.on('close', () => {
      hosts.delete(clientUsername);
      host.rpc.flush();
      console.log(`[server] host disconnected: ${clientUsername} (${hosts.size} remaining)`);
      host.broadcast({ type: 'host_status', connected: false });
    });
    ws.on('error', (e) => console.error(`[server] host error (${clientUsername}):`, e.message));

  // ── Client connection ──────────────────────────────────────────────────────
  } else if (url.pathname === '/ws') {
    let user;
    try { user = jwt.verify(url.searchParams.get('token'), JWT_SECRET); }
    catch { ws.close(1008, 'Unauthorized'); return; }

    const { username } = user;
    if (!clients.has(username)) clients.set(username, new Set());
    clients.get(username).add(ws);

    const host = hosts.get(username);
    ws.send(JSON.stringify({ type: 'host_status', connected: !!host }));
    if (host) {
      ws.send(JSON.stringify({ type: 'session_list', sessions: host.enrichSessions(), hostCwd: host.hostCwd }));
    }
    console.log(`[server] client connected: ${username} (${clients.get(username).size} for user)`);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      const logData = { type: msg.type, username };
      if (msg.sessionId) logData.sessionId = String(msg.sessionId).slice(0, 8);
      if (msg.type === 'user') logData.preview = String(msg.message?.content || '').slice(0, 60);
      appendLog({ level: 'info', msg: 'client→server', data: logData });

      const h = hosts.get(username);

      if (msg.type === 'user') {
        // Echo to all clients for this user, then forward to host
        const echo = JSON.stringify({ type: 'claude_line', sessionId: msg.sessionId, line: JSON.stringify({ type: 'user', message: msg.message }) });
        for (const c of clients.get(username) ?? []) {
          if (c.readyState === WebSocket.OPEN) c.send(echo);
        }
        if (h?.ws.readyState === WebSocket.OPEN) h.ws.send(data.toString());
        return;
      }

      if (msg.type === 'agent_ctl') {
        if (h?.ws.readyState === WebSocket.OPEN) h.ws.send(data.toString());
        return;
      }
    });

    ws.on('close', () => {
      clients.get(username)?.delete(ws);
      console.log(`[server] client disconnected: ${username} (${clients.get(username)?.size ?? 0} remaining)`);
    });
    ws.on('error', (e) => console.error(`[server] client error (${username}):`, e.message));

  } else {
    ws.close(1008, 'Unknown path');
  }
});

server.listen(PORT, () => console.log('[server] listening on port', PORT));
