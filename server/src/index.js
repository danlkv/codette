// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USERNAME   = process.env.CHAT_USERNAME || 'admin';
const PASSWORD   = process.env.CHAT_PASSWORD || 'changeme';
const JWT_SECRET = process.env.JWT_SECRET    || 'jwt-secret-change-me';
const HOST_KEY   = process.env.HOST_KEY      || 'host-key-change-me';
const PORT       = parseInt(process.env.PORT || '3000', 10);

// ── Log buffer ────────────────────────────────────────────────────────────────
const LOG_MAX   = 500;
const logBuffer = [];

function appendLog(entry) {
  logBuffer.push({ ...entry, serverTs: Date.now() });
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
}

// ── Server state ──────────────────────────────────────────────────────────────
let hostWs = null;
const clients = new Set();
const agents = new Map();               // sessionId → { active: bool, streaming: bool }
let sessionCache = [];                  // from last session_list from host
let hostCwd = null;                     // host's process.cwd() from last session_list
const pendingHistoryHttp = new Map();   // sessionId → res[]
const pendingDeleteHttp = new Map();    // sessionId → res
const pendingFsHttp     = new Map();   // key → res
const pendingFileHttp   = new Map();   // key → res
const pendingGitLogHttp  = new Map();  // sessionId → res
const pendingGitDiffHttp = new Map();  // key → res  (key = sessionId+':'+commit)

const app = express();
app.use(express.json());

// ── REST request logging ───────────────────────────────────────────────────────
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

// ── JWT auth helper ───────────────────────────────────────────────────────────
function requireJwt(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
}

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === USERNAME && password === PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// ── Agent state helpers ───────────────────────────────────────────────────────
function agentStateFor(sessionId) {
  const a = agents.get(sessionId);
  if (!a?.active) return null;
  return a.streaming ? 'running' : 'idle';
}

function enrichSessions(sessions) {
  return sessions.map(s => {
    const state = agentStateFor(s.id);
    return state ? { ...s, agentState: state } : s;
  });
}

// ── Sessions list ─────────────────────────────────────────────────────────────
app.get('/api/sessions', requireJwt, (_req, res) => {
  res.json({ sessions: enrichSessions(sessionCache), hostCwd });
});

// ── Session history ───────────────────────────────────────────────────────────
app.get('/api/sessions/:id/history', requireJwt, (req, res) => {
  const id = req.params.id;
  const offsetStr = req.query.offset;
  const offset = offsetStr !== undefined ? Number(offsetStr) : null;

  // Set a 30s timeout to avoid hanging forever if host doesn't reply
  const timer = setTimeout(() => {
    const pending = pendingHistoryHttp.get(id);
    if (pending) {
      const idx = pending.indexOf(res);
      if (idx !== -1) pending.splice(idx, 1);
      if (pending.length === 0) pendingHistoryHttp.delete(id);
    }
    if (!res.headersSent) res.status(504).json({ error: 'History request timed out' });
  }, 30000);

  res.on('close', () => clearTimeout(timer));

  // incremental = we sent an offset, so client should merge rather than replace
  const entry = { res, incremental: offset !== null && offset > 0, offset };

  if (pendingHistoryHttp.has(id)) {
    // Coalesce: another request already in flight for this sessionId
    pendingHistoryHttp.get(id).push(entry);
    // Do NOT send duplicate WS message to host
  } else {
    pendingHistoryHttp.set(id, [entry]);
    if (hostWs?.readyState === WebSocket.OPEN) {
      hostWs.send(JSON.stringify({
        type: 'get_session_history',
        sessionId: id,
        offset: offset !== null && offset > 0 ? offset : undefined,
      }));
    }
    // else: host down — will be re-sent on host reconnect
  }
});

// ── File system listing ───────────────────────────────────────────────────────
app.get('/api/sessions/:id/fs', requireJwt, (req, res) => {
  const id = req.params.id;
  const queryPath = req.query.path || null;
  const key = id + ':' + (queryPath || '');

  if (!hostWs || hostWs.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'Host not connected' });
  }

  const timer = setTimeout(() => {
    if (pendingFsHttp.get(key) === res) {
      pendingFsHttp.delete(key);
      if (!res.headersSent) res.status(504).json({ error: 'fs request timed out' });
    }
  }, 30000);
  res.on('close', () => clearTimeout(timer));

  pendingFsHttp.set(key, res);
  hostWs.send(JSON.stringify({ type: 'get_fs', sessionId: id, path: queryPath }));
});

// ── File content ──────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/file', requireJwt, (req, res) => {
  const id = req.params.id;
  const filePath = req.query.path;
  const key = id + ':' + filePath;

  if (!hostWs || hostWs.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'Host not connected' });
  }

  const timer = setTimeout(() => {
    if (pendingFileHttp.get(key) === res) {
      pendingFileHttp.delete(key);
      if (!res.headersSent) res.status(504).json({ error: 'file request timed out' });
    }
  }, 30000);
  res.on('close', () => clearTimeout(timer));

  pendingFileHttp.set(key, res);
  hostWs.send(JSON.stringify({ type: 'get_file', sessionId: id, path: filePath }));
});

// ── Git log ───────────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/log', requireJwt, (req, res) => {
  const id = req.params.id;
  if (!hostWs || hostWs.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'Host not connected' });
  const timer = setTimeout(() => {
    if (pendingGitLogHttp.get(id) === res) {
      pendingGitLogHttp.delete(id);
      if (!res.headersSent) res.status(504).json({ error: 'git log timed out' });
    }
  }, 30000);
  res.on('close', () => clearTimeout(timer));
  pendingGitLogHttp.set(id, res);
  hostWs.send(JSON.stringify({ type: 'get_git_log', sessionId: id }));
});

// ── Git diff ──────────────────────────────────────────────────────────────────
app.get('/api/sessions/:id/git/diff', requireJwt, (req, res) => {
  const id = req.params.id;
  const commit = req.query.commit;
  if (!commit) return res.status(400).json({ error: 'commit required' });
  if (!hostWs || hostWs.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'Host not connected' });
  const key = id + ':' + commit;
  const timer = setTimeout(() => {
    if (pendingGitDiffHttp.get(key) === res) {
      pendingGitDiffHttp.delete(key);
      if (!res.headersSent) res.status(504).json({ error: 'git diff timed out' });
    }
  }, 30000);
  res.on('close', () => clearTimeout(timer));
  pendingGitDiffHttp.set(key, res);
  hostWs.send(JSON.stringify({ type: 'get_git_diff', sessionId: id, commit }));
});

// ── Create session ────────────────────────────────────────────────────────────
app.post('/api/sessions', requireJwt, (req, res) => {
  const { cwd, firstMessage } = req.body || {};
  if (hostWs?.readyState === WebSocket.OPEN) {
    hostWs.send(JSON.stringify({ type: 'new_session', cwd, firstMessage }));
  }
  res.status(202).json({});
});

// ── Delete session ────────────────────────────────────────────────────────────
app.delete('/api/sessions/:id', requireJwt, (req, res) => {
  const id = req.params.id;
  pendingDeleteHttp.set(id, res);
  if (hostWs?.readyState === WebSocket.OPEN) {
    hostWs.send(JSON.stringify({ type: 'delete_session', sessionId: id }));
  }

  // Timeout guard in case host never replies
  const timer = setTimeout(() => {
    if (pendingDeleteHttp.get(id) === res) {
      pendingDeleteHttp.delete(id);
      if (!res.headersSent) res.status(504).json({ error: 'Delete timed out' });
    }
  }, 30000);
  res.on('close', () => clearTimeout(timer));
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const key = req.query.key || req.headers['x-host-key'];
  if (key !== HOST_KEY) return res.status(401).json({ error: 'Unauthorized' });
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

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');

  // ── Host connection ──────────────────────────────────────────────────────
  if (url.pathname === '/host') {
    if (url.searchParams.get('key') !== HOST_KEY) { ws.close(1008, 'Unauthorized'); return; }
    hostWs = ws;
    console.log('[server] host connected');

    // Ask host to populate session cache immediately
    hostWs.send(JSON.stringify({ type: 'list_sessions' }));
    broadcast({ type: 'host_status', connected: true });

    // Re-send any history requests that arrived while host was down
    for (const [sessionId, entries] of pendingHistoryHttp) {
      if (entries.length === 0) continue;
      const { offset } = entries[0]; // all coalesced entries share the same request
      hostWs.send(JSON.stringify({
        type: 'get_session_history',
        sessionId,
        offset: offset !== null && offset > 0 ? offset : undefined,
      }));
    }

    ws.on('message', (data) => {
      let ev;
      try { ev = JSON.parse(data.toString()); } catch {}

      if (ev?.type === 'log') {
        appendLog(ev);
        const data = ev.data ? ' ' + JSON.stringify(ev.data) : '';
        console.log(`[host][${ev.level}] ${ev.msg}${data}`);
        return;
      }

      if (ev?.type === 'claude_line') {
        // Broadcast per-session line to all WS clients
        broadcast({ type: 'claude_line', sessionId: ev.sessionId, line: ev.line });
        return;
      }

      if (ev?.type === 'agent_event') {
        const { sessionId, event } = ev;
        const current = agents.get(sessionId) || { active: false, streaming: false };
        agents.set(sessionId, {
          active: event === 'started' || event === 'streaming' || event === 'idle',
          streaming: event === 'streaming',
        });
        appendLog({ level: 'info', msg: 'agent_event', data: { sessionId: String(sessionId).slice(0, 8), event } });
        broadcast({ type: 'agent_event', sessionId, event });
        return;
      }

      if (ev?.type === 'session_list') {
        sessionCache = ev.sessions || [];
        if (ev.hostCwd) hostCwd = ev.hostCwd;
        broadcast({ type: 'session_list', sessions: enrichSessions(sessionCache), hostCwd });
        // Drain pending DELETE responses only for sessions confirmed gone
        const remainingIds = new Set(sessionCache.map(s => s.id));
        for (const [sessionId, res] of pendingDeleteHttp) {
          if (!remainingIds.has(sessionId)) {
            if (!res.headersSent) res.status(204).send();
            pendingDeleteHttp.delete(sessionId);
          }
        }
        return;
      }

      if (ev?.type === 'history') {
        const { sessionId, lines, totalLines } = ev;
        const pending = pendingHistoryHttp.get(sessionId);
        if (pending) {
          for (const { res, incremental } of pending) {
            if (!res.headersSent) {
              res.json({ lines: lines || [], incremental, totalLines });
            }
          }
          pendingHistoryHttp.delete(sessionId);
        }
        return;
      }

      if (ev?.type === 'fs_result') {
        const key = ev.sessionId + ':' + (ev.path || '');
        const res = pendingFsHttp.get(key);
        if (res && !res.headersSent) {
          ev.error ? res.status(500).json({ error: ev.error }) : res.json({ entries: ev.entries });
          pendingFsHttp.delete(key);
        }
        return;
      }

      if (ev?.type === 'file_result') {
        const key = ev.sessionId + ':' + ev.path;
        const res = pendingFileHttp.get(key);
        if (res && !res.headersSent) {
          ev.content !== null
            ? res.json({ content: ev.content })
            : res.status(422).json({ error: ev.error || 'unreadable' });
          pendingFileHttp.delete(key);
        }
        return;
      }

      if (ev?.type === 'git_log_result') {
        const res = pendingGitLogHttp.get(ev.sessionId);
        if (res && !res.headersSent) {
          ev.error
            ? res.status(500).json({ error: ev.error })
            : res.json({ commits: ev.commits, branch: ev.branch ?? null });
          pendingGitLogHttp.delete(ev.sessionId);
        }
        return;
      }

      if (ev?.type === 'git_diff_result') {
        const key = ev.sessionId + ':' + ev.commit;
        const res = pendingGitDiffHttp.get(key);
        if (res && !res.headersSent) {
          ev.diff !== null
            ? res.json({ diff: ev.diff })
            : res.status(422).json({ error: ev.error || 'diff failed' });
          pendingGitDiffHttp.delete(key);
        }
        return;
      }
    });

    ws.on('close', () => {
      hostWs = null;
      agents.clear();
      console.log('[server] host disconnected');
      broadcast({ type: 'host_status', connected: false });
    });
    ws.on('error', (e) => console.error('[server] host error:', e.message));

  // ── Client connection ────────────────────────────────────────────────────
  } else if (url.pathname === '/ws') {
    try { jwt.verify(url.searchParams.get('token'), JWT_SECRET); }
    catch { ws.close(1008, 'Unauthorized'); return; }

    clients.add(ws);
    ws.send(JSON.stringify({ type: 'host_status', connected: !!hostWs }));
    console.log('[server] client connected (%d total)', clients.size);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      const logData = { type: msg.type, clients: clients.size };
      if (msg.sessionId) logData.sessionId = String(msg.sessionId).slice(0, 8);
      if (msg.type === 'user') logData.preview = String(msg.message?.content || '').slice(0, 60);
      appendLog({ level: 'info', msg: 'client→server', data: logData });

      if (msg.type === 'user') {
        // Broadcast user echo to all clients as a claude_line immediately
        broadcast({
          type: 'claude_line',
          sessionId: msg.sessionId,
          line: JSON.stringify({ type: 'user', message: msg.message }),
        });
        // Then forward to host
        if (hostWs?.readyState === WebSocket.OPEN) hostWs.send(data.toString());
        return;
      }

      if (msg.type === 'agent_ctl') {
        // Forward to host
        if (hostWs?.readyState === WebSocket.OPEN) hostWs.send(data.toString());
        return;
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log('[server] client disconnected (%d remaining)', clients.size);
    });
    ws.on('error', (e) => console.error('[server] client error:', e.message));

  } else {
    ws.close(1008, 'Unknown path');
  }
});

server.listen(PORT, () => console.log('[server] listening on port', PORT));
