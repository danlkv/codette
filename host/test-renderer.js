#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

// Test ClaudeRenderer against real session JSONL (last 50 lines of session 2aff0c51).
// Usage: node test-renderer.js

import { readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ClaudeRenderer } from './renderer.js';

const SESSION_ID = '2aff0c51-e986-4772-8744-56f55760edad';
const claudeDir = join(homedir(), '.claude', 'projects');

let sessionFile;
for (const proj of readdirSync(claudeDir)) {
  const f = join(claudeDir, proj, `${SESSION_ID}.jsonl`);
  try { readFileSync(f, 'utf8').slice(0, 1); sessionFile = f; break; } catch {}
}
if (!sessionFile) throw new Error(`session ${SESSION_ID} not found`);

const lines = readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean).slice(-50);

// ── Print input summary ───────────────────────────────────────────────────────
console.log('=== INPUT (last 50 lines) ===');
for (const [i, l] of lines.entries()) {
  let ev; try { ev = JSON.parse(l); } catch { console.log(`${i}: <parse error>`); continue; }
  const role = ev.message?.role || ev.type || '?';
  const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
  const btypes = blocks.map(b => b.type);
  let preview = '';
  const text = blocks.find(b => b.type === 'text');
  const tool = blocks.find(b => b.type === 'tool_use');
  const think = blocks.find(b => b.type === 'thinking');
  if (text)  preview = ` "${text.text.slice(0, 70).replace(/\n/g, '↵')}"`;
  else if (tool)  preview = ` ${tool.name}`;
  else if (think) preview = ` "${think.thinking.slice(0, 70).replace(/\n/g, '↵')}"`;
  console.log(`${String(i).padStart(2)}: ${role.padEnd(9)} ${JSON.stringify(btypes)}${preview}`);
}

// ── Stream through renderer ───────────────────────────────────────────────────
console.log('\n=== OUTPUT (plain, no ANSI) ===');
const renderer = new ClaudeRenderer({ ansi: false });
let buf = '';
for (const line of lines) {
  buf += renderer.feed(line);
}
console.log(buf);
console.log(`=== END (buffer: ${buf.length} chars) ===`);
