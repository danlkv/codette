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

// ── Session state ─────────────────────────────────────────────────────────────
// Server is stateless w.r.t. history — host owns session files.
// streaming: true while Claude is generating (first assistant → session_snapshot)
// pendingHistory: clients waiting for snapshot from host (connected while not streaming,
//                 or connected while streaming and then streaming ended)
let streaming             = false;
let lastClaudeSessionId   = null;
let pendingResumeSessionId = null;   // set when a client requests resume; skip 'clear' for this id
const pendingHistory      = new Set(); // waiting for request_snapshot reply

const app = express();
app.use(express.json());

const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === USERNAME && password === PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});


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

app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

let hostWs = null;
const clients = new Set();

function requestSnapshot(ws) {
  // Park client and ask host to send current session snapshot
  pendingHistory.add(ws);
  if (hostWs?.readyState === WebSocket.OPEN) {
    hostWs.send(JSON.stringify({ type: 'request_snapshot' }));
  }
  // If host not connected yet, client stays parked until host connects and snapshot arrives
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');

  // ── Host connection ──────────────────────────────────────────────────────
  if (url.pathname === '/host') {
    if (url.searchParams.get('key') !== HOST_KEY) { ws.close(1008, 'Unauthorized'); return; }
    hostWs = ws;
    console.log('[server] host connected');
    broadcast({ type: 'status', host: 'connected' });

    // Any parked clients waiting for history — ask host immediately
    if (pendingHistory.size > 0) {
      hostWs.send(JSON.stringify({ type: 'request_snapshot' }));
    }
    // Populate sidebars of connected clients
    hostWs.send(JSON.stringify({ type: 'list_sessions' }));

    ws.on('message', (data) => {
      const line = data.toString();
      let ev;
      try { ev = JSON.parse(line); } catch {}

      // Host → server control messages (not forwarded as claude_lines)
      if (ev?.type === 'log') {
        appendLog(ev);
        return;
      }

      if (ev?.type === 'session_snapshot') {
        streaming = false;
        const histMsg = JSON.stringify({ type: 'history', lines: ev.lines || [] });
        const openClients = [...clients].filter(w => w.readyState === WebSocket.OPEN).length;
        appendLog({ level: 'info', msg: 'snapshot handler', data: { resume: ev.resume, lines: ev.lines?.length ?? 0, pendingHistory: pendingHistory.size, clients: clients.size, openClients } });
        // Promote parked clients and send history
        for (const pws of pendingHistory) {
          if (pws.readyState === WebSocket.OPEN) {
            clients.add(pws);
            pws.send(histMsg);
          }
        }
        pendingHistory.clear();
        // Push to already-active clients only for resume-triggered snapshots
        if (ev.resume) {
          for (const pws of clients) {
            if (pws.readyState === WebSocket.OPEN) pws.send(histMsg);
          }
        }
        console.log('[server] snapshot dispatched (%d lines)', ev.lines?.length ?? 0);
        hostWs.send(JSON.stringify({ type: 'list_sessions' }));
        return;
      }

      if (ev?.type === 'session_list') {
        broadcast({ type: 'session_list', sessions: ev.sessions });
        return;
      }

      // Detect new Claude session → clear all clients (skip for intentional resumes)
      if (ev?.type === 'system' && ev.subtype === 'init' && ev.session_id) {
        if (ev.session_id !== lastClaudeSessionId) {
          const isResume = pendingResumeSessionId &&
            ev.session_id.startsWith(pendingResumeSessionId);
          appendLog({ level: 'info', msg: 'system.init', data: { session: ev.session_id.slice(0, 8), pendingResumeSessionId: pendingResumeSessionId?.slice(0, 8) ?? null, isResume: !!isResume } });
          pendingResumeSessionId = null;
          lastClaudeSessionId = ev.session_id;
          streaming = false;
          if (!isResume) {
            broadcast({ type: 'clear' });
            console.log('[server] new claude session:', ev.session_id.slice(0, 8));
          } else {
            console.log('[server] resumed claude session:', ev.session_id.slice(0, 8));
          }
        }
      }

      if (ev?.type === 'assistant') streaming = true;

      // When a turn ends, promote any clients that connected mid-stream
      if (ev?.type === 'result' && pendingHistory.size > 0) {
        hostWs.send(JSON.stringify({ type: 'request_snapshot' }));
      }

      broadcast({ type: 'claude_line', line });
    });

    ws.on('close', () => {
      hostWs = null;
      console.log('[server] host disconnected');
      broadcast({ type: 'status', host: 'disconnected' });
    });
    ws.on('error', (e) => console.error('[server] host error:', e.message));

  // ── Client connection ────────────────────────────────────────────────────
  } else if (url.pathname === '/ws') {
    try { jwt.verify(url.searchParams.get('token'), JWT_SECRET); }
    catch { ws.close(1008, 'Unauthorized'); return; }

    ws.send(JSON.stringify({ type: 'status', host: hostWs ? 'connected' : 'disconnected', streaming }));

    if (streaming) {
      // Claude is mid-response: park until streaming ends, then request snapshot
      pendingHistory.add(ws);
      console.log('[server] client parked (streaming) (%d pending)', pendingHistory.size);
    } else {
      // Not streaming: request snapshot from host (host reads from disk)
      requestSnapshot(ws);
      console.log('[server] client requesting snapshot (%d pending)', pendingHistory.size);
    }

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const logData = { type: msg.type, clients: clients.size, pendingHistory: pendingHistory.size };
      if (msg.sessionId) logData.sessionId = String(msg.sessionId).slice(0, 8);
      if (msg.type === 'user') logData.preview = String(msg.message?.content || '').slice(0, 60);
      appendLog({ level: 'info', msg: 'client→server', data: logData });
      if (msg.type === 'resume' && msg.sessionId) {
        pendingResumeSessionId = msg.sessionId;
      }
      // resume and other control messages go to host, not Claude stdin
      if (hostWs?.readyState === WebSocket.OPEN) hostWs.send(data.toString());
    });

    ws.on('close', () => { clients.delete(ws); pendingHistory.delete(ws); });
    ws.on('error', (e) => console.error('[server] client error:', e.message));

  } else {
    ws.close(1008, 'Unknown path');
  }
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

server.listen(PORT, () => console.log('[server] listening on port', PORT));
