// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

// ── ClaudeRenderer ────────────────────────────────────────────────────────────
// Accepts Claude stream-json or session-file JSONL lines, returns strings to print.

const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', gray: '\x1b[90m', white: '\x1b[97m',
};
const PLAIN = Object.fromEntries(Object.keys(ANSI).map(k => [k, '']));

export function toolSummary(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Bash': {
      const first = (input.command || '').split('\n')
        .find(l => l.trim() && !l.trim().startsWith('#'));
      return first?.trim().slice(0, 80) || '';
    }
    case 'WebSearch':
    case 'web_search': return input.query || '';
    case 'Read':
    case 'Write':
    case 'Edit':       return input.file_path || input.path || '';
    case 'Grep':       return input.pattern || '';
    case 'LS':         return input.path || '';
    default:           return '';
  }
}

export class ClaudeRenderer {
  constructor({ ansi = true, summarize = toolSummary } = {}) {
    this._C = ansi ? ANSI : PLAIN;
    this._summarize = summarize;
    this._reset();
  }

  // Feed a JSONL line or parsed object; returns string to write to terminal.
  // tag: optional per-agent prefix (e.g. "[abc123] ") for multi-agent display.
  feed(line, tag = '') {
    let ev;
    try { ev = typeof line === 'string' ? JSON.parse(line) : line; } catch { return ''; }
    // Support stream-json (ev.type) and session-file (ev.message.role) formats
    const evType = ev.type || ev.message?.role;
    if (evType === 'assistant') return this._assistant(ev, tag);
    if (evType === 'result')    return this._result(ev, tag);
    return '';
  }

  _reset() {
    this._seenTools     = new Set();
    this._inTurn        = false;
    this._thinkingLogged     = false;
    this._thinkingDoneLogged = false;
    this._needsNewline  = false;
  }

  _assistant(ev, tag) {
    const C = this._C;
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    let out = '';

    const hasThinking = content.some(b => b.type === 'thinking');
    const hasText     = content.some(b => b.type === 'text');

    if (hasThinking && !this._thinkingLogged) {
      if (!this._inTurn) { out += `\n${tag}${C.bold}${C.green}claude${C.reset}  `; this._inTurn = true; }
      out += `${C.dim}[thinking…]${C.reset}`;
      this._thinkingLogged = true;
    }
    if (hasText && this._thinkingLogged && !this._thinkingDoneLogged) {
      out += ` ${C.dim}[done]${C.reset}`;
      this._thinkingDoneLogged = true;
      this._needsNewline = true;
    }

    for (const b of content) {
      if (b.type === 'text') {
        if (!this._inTurn) { out += `\n${tag}${C.bold}${C.green}claude${C.reset}  `; this._inTurn = true; }
        if (this._needsNewline) { out += '\n'; this._needsNewline = false; }
        out += `${C.white}${b.text}${C.reset}`;
      }
    }

    for (const b of content) {
      if (b.type === 'tool_use' && !this._seenTools.has(b.id)) {
        this._seenTools.add(b.id);
        if (!this._inTurn) { out += `\n${tag}${C.bold}${C.green}claude${C.reset}  `; this._inTurn = true; }
        const sum = this._summarize(b.name, b.input);
        out += `\n${tag}${C.yellow}⚙ ${b.name}${C.reset}${sum ? `  ${C.dim}${sum}${C.reset}` : ''}`;
        this._needsNewline = true;
      }
    }

    return out;
  }

  _result(ev, tag) {
    const C = this._C;
    const cost = ev.total_cost_usd;
    const out = `\n${tag}${C.gray}— ${cost != null ? `$${cost.toFixed(4)}` : ev.subtype} —${C.reset}\n${C.dim}${'─'.repeat(60)}${C.reset}\n`;
    this._reset();
    return out;
  }
}
