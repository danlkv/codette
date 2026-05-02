#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:3000';
const HOST_KEY   = process.env.HOST_KEY   || 'host-key-change-me';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const A = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  gray:   '\x1b[90m',
  white:  '\x1b[97m',
};
const w  = (s) => process.stdout.write(s);
const hr = () => w(`${A.dim}${'─'.repeat(60)}${A.reset}\n`);

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

// ── Streaming state ───────────────────────────────────────────────────────────
let prevText  = '';
let seenTools = new Set();
let inTurn    = false;

function renderLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }

  if (ev.type === 'system' && ev.subtype === 'init') {
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
const claude = spawn('claude', [
  '--dangerously-skip-permissions',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
], { stdio: ['pipe', 'pipe', 'inherit'] });

claude.on('exit', (code) => {
  w(`\n${A.dim}claude exited (${code})${A.reset}\n`);
  process.exit(code ?? 0);
});

// ── Output pipeline (set up once, not per-reconnect) ─────────────────────────
let ws;
let buf = '';

claude.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    renderLine(line);
    if (ws?.readyState === WebSocket.OPEN) ws.send(line);
  }
});

// ── Server connection ─────────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(`${SERVER_URL}/host?key=${encodeURIComponent(HOST_KEY)}`);

  ws.on('open', () => {
    hr();
    w(`${A.bold}${A.cyan}Claude Web Host${A.reset}  ${A.gray}${SERVER_URL}${A.reset}\n`);
    hr();
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'user' && msg.message?.content) {
      w(`\n${A.bold}${A.blue}you${A.reset}  ${msg.message.content}\n`);
    }
    claude.stdin.write(data.toString() + '\n');
  });

  ws.on('close', () => {
    w(`${A.gray}disconnected, reconnecting…${A.reset}\n`);
    setTimeout(connect, 3000);
  });

  ws.on('error', (e) => w(`${A.gray}ws error: ${e.message}${A.reset}\n`));
}

connect();
