#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { spawn, execSync } from 'child_process';
import { WebSocket } from 'ws';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';
import { ClaudeRenderer, toolSummary } from './renderer.js';
import { RpcServer } from './rpc.js';

const SERVER_URL       = process.env.SERVER_URL       || 'ws://localhost:3000';
const CLIENT_USERNAME  = process.env.CLIENT_USERNAME  || hostname();
const CLIENT_PASSWORD  = process.env.CLIENT_PASSWORD  || 'changeme';
const HOST_TOKEN       = process.env.HOST_KEY         || 'host-key-change-me';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const A = {
  reset:  '\x1b[0m', bold:  '\x1b[1m', dim:   '\x1b[2m',
  cyan:   '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue:   '\x1b[34m', gray:  '\x1b[90m', white:  '\x1b[97m',
};
const w  = (s) => process.stdout.write(s);
const hr = () => w(`${A.dim}${'─'.repeat(60)}${A.reset}\n`);

// ── Centralized logging ────────────────────────────────────────────────────────
const logQueue = [];  // buffer while ws not yet connected

function log(level, msg, data = null) {
  const color = level === 'error' ? A.yellow : level === 'warn' ? A.yellow : A.gray;
  w(`${color}[${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}${A.reset}\n`);
  const entry = { type: 'log', ts: Date.now(), level, msg, ...(data && { data }) };
  if (ws?.readyState === WebSocket.OPEN) {
    while (logQueue.length) ws.send(JSON.stringify(logQueue.shift()));
    ws.send(JSON.stringify(entry));
  } else {
    logQueue.push(entry);
  }
}


// ── Session tracking ──────────────────────────────────────────────────────────
const sessionMetaCache = new Map(); // filePath → { mtime, title, msgCount }

function findSessionFile(sessionId) {
  if (!sessionId) return null;
  const claudeDir = join(homedir(), '.claude', 'projects');
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
  const claudeDir = join(homedir(), '.claude', 'projects');
  const sessions = [];
  const activeIds = new Set(agents.keys());
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
          sessions.push({ id, title, ts, agentActive: activeIds.has(id), msgCount, cwd });
        }
      } catch {}
    }
  } catch {}
  return sessions.sort((a, b) => b.ts - a.ts);
}

function sendSessionList() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'session_list', sessions: listSessions(), hostCwd: process.cwd() }));
}

// ── Agent registry ────────────────────────────────────────────────────────────
// Map<sessionId, { proc, buf, streaming, renderer, sessionId }>
const agents = new Map();

function sendAgentEvent(sessionId, event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'agent_event', sessionId, event }));
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
  ], { stdio: ['pipe', 'pipe', 'pipe'], ...(spawnCwd && { cwd: spawnCwd }) });

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
          if (newId && ws?.readyState === WebSocket.OPEN) {
            const list = listSessions();
            if (!list.find(s => s.id === newId)) {
              list.unshift({ id: newId, title: '', ts: Date.now(), agentActive: true, msgCount: 0, cwd: ev.cwd || null });
            }
            ws.send(JSON.stringify({ type: 'session_list', sessions: list, hostCwd: process.cwd() }));
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

      // Forward tagged line to server
      const sessionId = agentEntry.sessionId;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'claude_line', sessionId, line }));
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

rpc.register('get_fs', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  const path = msg.path || sessionCwd;
  if (!path || !sessionCwd || !path.startsWith(sessionCwd)) throw new Error('path outside session cwd');
  const entries = readdirSync(path, { withFileTypes: true })
    .map(e => ({ name: e.name, path: join(path, e.name), isDir: e.isDirectory() }))
    .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  log('info', 'get_fs', { path, entries: entries.length });
  return { entries };
});

rpc.register('get_file', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  if (!msg.path || !sessionCwd || !msg.path.startsWith(sessionCwd)) throw new Error('path outside session cwd');
  const buf = readFileSync(msg.path);
  if (buf.length > 512 * 1024) throw new Error('file too large');
  if (buf.includes(0)) throw new Error('binary file');
  log('info', 'get_file', { path: msg.path, size: buf.length });
  return { content: buf.toString('utf8') };
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

rpc.register('get_git_diff', (msg) => {
  const sessionCwd = getSessionCwd(msg.sessionId);
  if (!sessionCwd) throw new Error('no cwd for session');
  const MAX = 256 * 1024;
  const diff = execSync(`git show --unified=3 ${msg.commit}`, { cwd: sessionCwd, maxBuffer: MAX + 1 }).toString();
  log('info', 'get_git_diff', { commit: msg.commit, size: diff.length });
  return { diff: diff.slice(0, MAX) };
});

// ── Server connection ─────────────────────────────────────────────────────────
let ws;

function connect() {
  ws = new WebSocket(`${SERVER_URL}/host?token=${encodeURIComponent(HOST_TOKEN)}&clientUsername=${encodeURIComponent(CLIENT_USERNAME)}&clientPassword=${encodeURIComponent(CLIENT_PASSWORD)}`);

  ws.on('open', () => {
    // Flush buffered logs now that we're connected
    while (logQueue.length) ws.send(JSON.stringify(logQueue.shift()));
    hr();
    w(`${A.bold}${A.cyan}Claude Web Host${A.reset}  ${A.gray}${SERVER_URL}${A.reset}\n`);
    w(`${A.dim}Serving clients as: ${A.reset}${A.white}${CLIENT_USERNAME}${A.reset}  ${A.dim}password: ${A.reset}${A.white}${CLIENT_PASSWORD}${A.reset}\n`);
    hr();
    log('info', 'host connected to server', { url: SERVER_URL });
    sendSessionList();
    // Re-announce agent states in one batch so server map is correct after reconnect/restart
    const states = {};
    for (const [sessionId, entry] of agents) {
      if (sessionId) states[sessionId] = entry.streaming ? 'streaming' : 'idle';
    }
    if (Object.keys(states).length > 0) ws.send(JSON.stringify({ type: 'agent_event', states }));
  });

  ws.on('message', async (data) => {
    const raw = data.toString();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (await rpc.handle(ws, msg)) return;

    if (msg.type === 'list_sessions') {
      log('info', 'list_sessions requested');
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
      log('info', 'new session requested', { cwd, hasMsg: !!firstMessage });
      const agentEntry = spawnClaude([], null, cwd);
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

    if (msg.type === 'get_session_history') {
      const { sessionId, offset } = msg;
      const file = findSessionFile(sessionId);
      let lines = [];
      let totalLines = 0;
      if (file) {
        try {
          const raw = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
          lines = (offset != null && offset > 0) ? raw.slice(offset) : raw;
          totalLines = raw.length;
          log('info', `history sent (${lines.length} lines, offset ${offset ?? 0}, total ${totalLines})`, { sessionId: String(sessionId).slice(0, 8) });
        } catch (e) { log('error', `history read error: ${e.message}`); }
      } else {
        log('warn', `session file not found`, { sessionId: String(sessionId).slice(0, 8) });
      }
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'history', sessionId, lines, totalLines }));
      }
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

      let agentEntry = agents.get(sessionId);
      if (!agentEntry) {
        // No running agent — auto-resume this session then write message
        log('info', 'no agent for session, auto-resuming', { sessionId: String(sessionId).slice(0, 8) });
        agentEntry = spawnClaude(['--resume', sessionId], sessionId);
        // Write after a tick so the process has started
        setImmediate(() => {
          const ok = agentEntry.proc.stdin.write(JSON.stringify(msg) + '\n');
          if (!ok) log('warn', 'stdin write buffered (backpressure)');
        });
      } else {
        const ok = agentEntry.proc.stdin.write(JSON.stringify(msg) + '\n');
        if (!ok) log('warn', 'stdin write buffered (backpressure)');
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
