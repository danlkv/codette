#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

// Usage: node test-summarize.mjs <path-to.jsonl>
// Reports before/after line counts and sizes, and per-event-type breakdown.

import { readFileSync } from 'fs';
import { summarizeOldLines, KEEP, TRUNC, TRUNC_RESULT } from './src/lib/summarize.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const kb = s => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB';
const kbN = n => (n / 1024).toFixed(1) + ' KB';

function byteSize(lines) {
  return lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 1, 0); // +1 for \n
}

function breakdown(lines) {
  const counts = {};
  const sizes = {};
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const key = ev.type === 'user' && Array.isArray(ev.message?.content) ? 'user(tool_results)'
      : ev.type === 'user' ? 'user(text)'
      : ev.type ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    sizes[key] = (sizes[key] ?? 0) + Buffer.byteLength(line, 'utf8');
  }
  return { counts, sizes };
}

function printBreakdown(label, lines) {
  const { counts, sizes } = breakdown(lines);
  console.log(`\n  ${label}:`);
  for (const k of Object.keys(counts).sort()) {
    console.log(`    ${k.padEnd(22)} ${String(counts[k]).padStart(5)} lines  ${kbN(sizes[k]).padStart(10)}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const file = process.argv[2];
if (!file) { console.error('Usage: node test-summarize.mjs <path.jsonl>'); process.exit(1); }

const raw = readFileSync(file, 'utf8');
const lines = raw.split('\n').filter(l => l.trim());
const rawSize = byteSize(lines);

console.log(`\nInput: ${file}`);
console.log(`  Lines: ${lines.length}  Size: ${kbN(rawSize)}`);
printBreakdown('by type', lines);

// Apply same split as tryStoreHistory
const oldLines = lines.length > KEEP ? lines.slice(0, -KEEP) : lines;
const keepLines = lines.length > KEEP ? lines.slice(-KEEP) : [];

const summarized = [...summarizeOldLines(oldLines), ...keepLines];
const sumSize = byteSize(summarized);

console.log(`\nAfter summarizeOldLines (KEEP=${KEEP}, TRUNC=${TRUNC}, TRUNC_RESULT=${TRUNC_RESULT}):`);
console.log(`  Lines: ${summarized.length}  Size: ${kbN(sumSize)}  (${((1 - sumSize/rawSize)*100).toFixed(1)}% reduction)`);
printBreakdown('by type', summarized);

// Per-line savings detail for tool results
const toolResultSavings = [];
for (let i = 0; i < oldLines.length; i++) {
  let ev;
  try { ev = JSON.parse(oldLines[i]); } catch { continue; }
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    const before = Buffer.byteLength(oldLines[i], 'utf8');
    const after = Buffer.byteLength(summarized[i], 'utf8');
    if (before !== after) toolResultSavings.push(before - after);
  }
}
if (toolResultSavings.length) {
  const total = toolResultSavings.reduce((a, b) => a + b, 0);
  const avg = total / toolResultSavings.length;
  console.log(`\n  tool_result truncations: ${toolResultSavings.length} events truncated`);
  console.log(`    avg saving: ${kbN(avg)}  total saving: ${kbN(total)}`);
}

// Tool use input savings
const tuSavings = [];
for (let i = 0; i < oldLines.length; i++) {
  let ev;
  try { ev = JSON.parse(oldLines[i]); } catch { continue; }
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    const before = Buffer.byteLength(oldLines[i], 'utf8');
    const after = Buffer.byteLength(summarized[i], 'utf8');
    if (before !== after) tuSavings.push({ saving: before - after, before, after });
  }
}
if (tuSavings.length) {
  const total = tuSavings.reduce((a, b) => a + b.saving, 0);
  const avg = total / tuSavings.length;
  console.log(`\n  assistant event compressions: ${tuSavings.length} events changed`);
  console.log(`    avg saving: ${kbN(avg)}  total saving: ${kbN(total)}`);
}

// ── histogram of compressed message sizes ────────────────────────────────────

function histogram(values, buckets) {
  const counts = new Array(buckets.length + 1).fill(0);
  for (const v of values) {
    let placed = false;
    for (let i = 0; i < buckets.length; i++) {
      if (v <= buckets[i]) { counts[i]++; placed = true; break; }
    }
    if (!placed) counts[buckets.length]++;
  }
  return counts;
}

function printHistogram(label, sizes) {
  const BUCKETS = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  const labels = ['≤100B','≤200B','≤500B','≤1KB','≤2KB','≤5KB','≤10KB','≤20KB','≤50KB','>50KB'];
  const counts = histogram(sizes, BUCKETS);
  const max = Math.max(...counts);
  const BAR = 40;
  console.log(`\n  ${label} (n=${sizes.length}):`);
  for (let i = 0; i < labels.length; i++) {
    if (counts[i] === 0) continue;
    const bar = '█'.repeat(Math.round(counts[i] / max * BAR));
    console.log(`    ${labels[i].padStart(6)}  ${String(counts[i]).padStart(5)}  ${bar}`);
  }
}

const compressedSizes = summarized.map(l => Buffer.byteLength(l, 'utf8'));
const byType = {};
for (let i = 0; i < summarized.length; i++) {
  let ev; try { ev = JSON.parse(summarized[i]); } catch { continue; }
  const key = ev.type === 'user' && Array.isArray(ev.message?.content) ? 'user(tool_results)'
    : ev.type === 'user' ? 'user(text)' : ev.type ?? 'unknown';
  if (!byType[key]) byType[key] = [];
  byType[key].push(compressedSizes[i]);
}

console.log('\n── Compressed size histograms ──');
printHistogram('all lines', compressedSizes);
for (const [type, sizes] of Object.entries(byType).sort()) {
  printHistogram(type, sizes);
}
