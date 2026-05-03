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
// Map<sessionId, { proc, buf, streaming, prevText, seenTools, inTurn }>
const agents = new Map();

function sendAgentEvent(sessionId, event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'agent_event', sessionId, event }));
}

// ── Streaming / terminal rendering ───────────────────────────────────────────
function renderLine(line, agentEntry) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }

  // When multiple agents are running, prefix each line with a short session tag
  const sid = agentEntry.sessionId?.slice(0, 6) ?? '??????';
  const tag = agents.size > 1 ? `${A.gray}[${sid}]${A.reset} ` : '';

  if (ev.type === 'assistant') {
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    let text = '';
    for (const b of content) {
      if (b.type === 'text') text += b.text;
      if (b.type === 'tool_use' && !agentEntry.seenTools.has(b.id)) {
        agentEntry.seenTools.add(b.id);
        if (!agentEntry.inTurn) { w(`\n${tag}${A.bold}${A.green}claude${A.reset}  `); agentEntry.inTurn = true; }
        const sum = toolSummary(b.name, b.input);
        w(`\n${tag}${A.yellow}⚙ ${b.name}${A.reset}${sum ? `  ${A.dim}${sum}${A.reset}` : ''}`);
      }
    }
    if (text) {
      if (!agentEntry.inTurn) { w(`\n${tag}${A.bold}${A.green}claude${A.reset}  `); agentEntry.inTurn = true; }
      if (text.length > agentEntry.prevText.length) w(`${A.white}${text.slice(agentEntry.prevText.length)}${A.reset}`);
      agentEntry.prevText = text;
    }
    return;
  }

  if (ev.type === 'result') {
    const cost = ev.total_cost_usd;
    w(`\n${tag}${A.gray}— ${cost != null ? `$${cost.toFixed(4)}` : ev.subtype} —${A.reset}\n`);
    hr();
    agentEntry.prevText = ''; agentEntry.seenTools = new Set(); agentEntry.inTurn = false;
    return;
  }
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
    prevText: '',
    seenTools: new Set(),
    inTurn: false,
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

// ── Server connection ─────────────────────────────────────────────────────────
let ws;

function connect() {
  ws = new WebSocket(`${SERVER_URL}/host?key=${encodeURIComponent(HOST_KEY)}`);

  ws.on('open', () => {
    // Flush buffered logs now that we're connected
    while (logQueue.length) ws.send(JSON.stringify(logQueue.shift()));
    hr();
    w(`${A.bold}${A.cyan}Claude Web Host${A.reset}  ${A.gray}${SERVER_URL}${A.reset}\n`);
    hr();
    log('info', 'host connected to server', { url: SERVER_URL });
    sendSessionList();
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

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
      if (file) {
        try {
          const raw = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
          lines = (offset != null && offset > 0) ? raw.slice(offset) : raw;
          log('info', `history sent (${lines.length} lines, offset ${offset ?? 0})`, { sessionId: String(sessionId).slice(0, 8) });
        } catch (e) { log('error', `history read error: ${e.message}`); }
      } else {
        log('warn', `session file not found`, { sessionId: String(sessionId).slice(0, 8) });
      }
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'history', sessionId, lines }));
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
