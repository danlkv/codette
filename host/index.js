#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:3000';
const HOST_KEY   = process.env.HOST_KEY   || 'host-key-change-me';

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

function toolSummary(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Bash': {
      const first = (input.command || '').split('\n')
        .find(l => l.trim() && !l.trim().startsWith('#'));
      return first?.trim().slice(0, 80) || '';
    }
    case 'WebSearch':
    case 'web_search':  return input.query    || '';
    case 'Read':
    case 'Write':
    case 'Edit':        return input.file_path || input.path || '';
    case 'Grep':        return input.pattern   || '';
    case 'LS':          return input.path       || '';
    default:            return '';
  }
}

// ── Session tracking ──────────────────────────────────────────────────────────
let currentSessionId = null;
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

function sendSessionSnapshot({ resume = false } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  let lines = [];
  if (currentSessionId) {
    const file = findSessionFile(currentSessionId);
    if (file) {
      try {
        lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
        log('info', `snapshot sent (${lines.length} lines)`, { sessionId: currentSessionId.slice(0, 8), resume });
      } catch (e) { log('error', `snapshot read error: ${e.message}`); }
    } else {
      log('warn', `session file not found`, { sessionId: currentSessionId.slice(0, 8) });
    }
  }
  ws.send(JSON.stringify({ type: 'session_snapshot', lines, resume }));
  sendSessionList();
}

function listSessions() {
  const claudeDir = join(homedir(), '.claude', 'projects');
  const sessions = [];
  try {
    for (const project of readdirSync(claudeDir)) {
      const projectDir = join(claudeDir, project);
      try {
        for (const file of readdirSync(projectDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const id = file.replace('.jsonl', '');
          const filePath = join(projectDir, file);
          let title = '', ts = 0, msgCount = 0;
          try {
            ts = statSync(filePath).mtimeMs;
            const cached = sessionMetaCache.get(filePath);
            if (cached && cached.mtime === ts) {
              ({ title, msgCount } = cached);
            } else {
              const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
              for (const line of lines) {
                try {
                  const ev = JSON.parse(line);
                  if (ev.type === 'user' && typeof ev.message?.content === 'string' && ev.message.content.trim()) {
                    if (!title) title = ev.message.content.slice(0, 80);
                    msgCount++;
                  } else if (ev.type === 'assistant' && ev.message?.stop_reason) {
                    msgCount++;
                  }
                } catch {}
              }
              sessionMetaCache.set(filePath, { mtime: ts, title, msgCount });
            }
          } catch {}
          sessions.push({ id, title, ts, active: id === currentSessionId, msgCount });
        }
      } catch {}
    }
  } catch {}
  return sessions.sort((a, b) => b.ts - a.ts);
}

function sendSessionList() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'session_list', sessions: listSessions() }));
}

// ── Streaming state ───────────────────────────────────────────────────────────
let prevText  = '';
let seenTools = new Set();
let inTurn    = false;

function renderLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }

  if (ev.type === 'system' && ev.subtype === 'init') {
    currentSessionId = ev.session_id ?? null;
    w(`${A.gray}session ${ev.session_id?.slice(0, 8) ?? '?'}${A.reset}\n`);
    return;
  }

  if (ev.type === 'assistant') {
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    let text = '';
    for (const b of content) {
      if (b.type === 'text') text += b.text;
      if (b.type === 'tool_use' && !seenTools.has(b.id)) {
        seenTools.add(b.id);
        if (!inTurn) { w(`\n${A.bold}${A.green}claude${A.reset}  `); inTurn = true; }
        const sum = toolSummary(b.name, b.input);
        w(`\n${A.yellow}⚙ ${b.name}${A.reset}${sum ? `  ${A.dim}${sum}${A.reset}` : ''}`);
      }
    }
    if (text) {
      if (!inTurn) { w(`\n${A.bold}${A.green}claude${A.reset}  `); inTurn = true; }
      if (text.length > prevText.length) w(`${A.white}${text.slice(prevText.length)}${A.reset}`);
      prevText = text;
    }
    return;
  }

  if (ev.type === 'result') {
    const cost = ev.total_cost_usd;
    w(`\n${A.gray}— ${cost != null ? `$${cost.toFixed(4)}` : ev.subtype} —${A.reset}\n`);
    hr();
    prevText = ''; seenTools = new Set(); inTurn = false;
    return;
  }
}

// ── Claude process ────────────────────────────────────────────────────────────
let claudeProc = null;
let buf = '';
let ws;

function handleClaudeOutput(chunk) {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    renderLine(line);
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'system' || ev.type === 'result') {
        log('info', `claude → ${ev.type}`, { subtype: ev.subtype, session: ev.session_id?.slice(0, 8) });
      }
      // snapshot is now requested by the server only when pending clients exist
    } catch {}
    if (ws?.readyState === WebSocket.OPEN) ws.send(line);
    else log('warn', 'ws not open, dropping claude line');
  }
}

function spawnClaude(extraArgs = []) {
  const oldProc = claudeProc;
  if (oldProc) {
    oldProc.stdout.removeListener('data', handleClaudeOutput);
    oldProc.kill();
  }
  buf = ''; prevText = ''; seenTools = new Set(); inTurn = false;

  const resumeIdx = extraArgs.indexOf('--resume');
  const spawnCwd = resumeIdx !== -1 ? getSessionCwd(extraArgs[resumeIdx + 1]) : null;

  log('info', 'spawning claude', { args: extraArgs, cwd: spawnCwd });

  const proc = spawn('claude', [
    '--dangerously-skip-permissions',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    ...extraArgs,
  ], { stdio: ['pipe', 'pipe', 'pipe'], ...(spawnCwd && { cwd: spawnCwd }) });
  claudeProc = proc;

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trimEnd();
    log('error', `[stderr] ${msg}`);
  });

  proc.on('exit', (code, signal) => {
    if (proc !== claudeProc) return; // replaced by respawn — ignore
    if (code === 0 || code === null) {
      log('info', `claude exited`, { code, signal });
      process.exit(0);
    } else {
      log('error', `claude exited unexpectedly`, { code, signal });
      spawnClaude();
    }
  });
  proc.stdout.on('data', handleClaudeOutput);
  return proc;
}

spawnClaude();

// ── Server connection ─────────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(`${SERVER_URL}/host?key=${encodeURIComponent(HOST_KEY)}`);

  ws.on('open', () => {
    // Flush buffered logs now that we're connected
    while (logQueue.length) ws.send(JSON.stringify(logQueue.shift()));
    hr();
    w(`${A.bold}${A.cyan}Claude Web Host${A.reset}  ${A.gray}${SERVER_URL}${A.reset}\n`);
    hr();
    log('info', 'host connected to server', { url: SERVER_URL });
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Control messages handled by host, not forwarded to Claude
    if (msg.type === 'request_snapshot') {
      sendSessionSnapshot();
      return;
    }

    if (msg.type === 'list_sessions') {
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

    if (msg.type === 'resume') {
      log('info', 'resume requested', { sessionId: String(msg.sessionId).slice(0, 8) });
      currentSessionId = msg.sessionId;
      spawnClaude(['--resume', msg.sessionId]);
      sendSessionSnapshot({ resume: true });
      return;
    }

    // User messages and Claude slash commands → stdin
    if (msg.type === 'user' && msg.message?.content) {
      w(`\n${A.bold}${A.blue}you${A.reset}  ${msg.message.content}\n`);
      log('info', 'user message → stdin', { preview: msg.message.content.slice(0, 60) });
    }
    const ok = claudeProc.stdin.write(raw + '\n');
    if (!ok) log('warn', 'stdin write buffered (backpressure)');
  });

  ws.on('close', () => {
    log('warn', 'disconnected from server, reconnecting…');
    setTimeout(connect, 3000);
  });

  ws.on('error', (e) => log('error', `ws error: ${e.message}`));
}

connect();
