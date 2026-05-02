// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USERNAME   = process.env.CHAT_USERNAME || 'admin';
const PASSWORD   = process.env.CHAT_PASSWORD || 'changeme';
const JWT_SECRET = process.env.JWT_SECRET    || 'jwt-secret-change-me';
const HOST_KEY   = process.env.HOST_KEY      || 'host-key-change-me';
const PORT       = parseInt(process.env.PORT || '3000', 10);
const HISTORY_FILE = process.env.HISTORY_FILE || '/data/history.json';

// ── History ──────────────────────────────────────────────────────────────────
let historyLines = [];
try {
  const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
  historyLines = JSON.parse(raw);
  console.log('[server] loaded %d history lines', historyLines.length);
} catch {}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyLines)); } catch {}
}

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


app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

let hostWs = null;
let lastClaudeSessionId = null;
const clients = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/host') {
    if (url.searchParams.get('key') !== HOST_KEY) {
      ws.close(1008, 'Unauthorized');
      return;
    }
    hostWs = ws;
    console.log('[server] host connected');
    broadcast({ type: 'status', host: 'connected' });

    ws.on('message', (data) => {
      const line = data.toString();
      // detect new Claude session via system init event
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
          if (ev.session_id !== lastClaudeSessionId) {
            lastClaudeSessionId = ev.session_id;
            historyLines = [];
            saveHistory();
            broadcast({ type: 'clear' });
            console.log('[server] new claude session:', ev.session_id.slice(0, 8));
          }
        }
      } catch {}
      historyLines.push(line);
      saveHistory();
      broadcast({ type: 'claude_line', line });
    });
    ws.on('close', () => {
      hostWs = null;
      console.log('[server] host disconnected');
      broadcast({ type: 'status', host: 'disconnected' });
    });
    ws.on('error', (e) => console.error('[server] host error:', e.message));

  } else if (url.pathname === '/ws') {
    try {
      jwt.verify(url.searchParams.get('token'), JWT_SECRET);
    } catch {
      ws.close(1008, 'Unauthorized');
      return;
    }
    clients.add(ws);
    console.log('[server] client connected (%d total)', clients.size);
    ws.send(JSON.stringify({ type: 'status', host: hostWs ? 'connected' : 'disconnected' }));
    if (historyLines.length > 0)
      ws.send(JSON.stringify({ type: 'history', lines: historyLines }));

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'clear') {
        historyLines = [];
        saveHistory();
        return;
      }
      if (msg.type === 'user') {
        historyLines.push(JSON.stringify({ type: 'user_message', text: msg.message?.content }));
        saveHistory();
      }
      if (hostWs?.readyState === WebSocket.OPEN) hostWs.send(data.toString());
    });
    ws.on('close', () => clients.delete(ws));
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
