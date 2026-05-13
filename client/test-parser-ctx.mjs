// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

/**
 * Quick smoke test for lastContextUsage extraction in parser.js
 * Run: node test-parser-ctx.mjs
 */

// Minimal Svelte store stub
function writable(init) {
  let val = init;
  return {
    set(v) { val = v; },
    update(fn) { val = fn(val); },
    get() { return val; },
    subscribe() {},
  };
}

// Stub get() from svelte/store
const get = s => s.get();

// Patch imports
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// We need to mock svelte/store for the parser import.
// Simplest: inline a copy of the createParser logic here and test it.
// (Avoids needing a full module resolver.)

// ── inline the relevant parser logic ──────────────────────────────────────────

function createParserForTest({ lastContextUsage }) {
  let msgCounter = 0;
  const uid = () => ++msgCounter;
  const msgs = [];
  const mutMsg = fn => { const r = fn(msgs); msgs.length = 0; msgs.push(...r); };
  let seenToolIds = new Set();
  let liveClaudeId = null;
  let liveUid = null;

  function resetTurnState() { seenToolIds = new Set(); liveClaudeId = null; liveUid = null; }
  function finalizeIncomplete() { resetTurnState(); }

  function parseLine(line) {
    let ev; try { ev = JSON.parse(line); } catch { return; }

    if (ev.type === 'assistant') {
      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      // session-complete assistant event
      const stopReason = ev.message?.stop_reason;
      const usage = ev.message?.usage;
      if (stopReason != null && usage && lastContextUsage) {
        const inputTotal = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        lastContextUsage.set({
          used: inputTotal,
          total: 200000,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          out: usage.output_tokens ?? 0,
        });
      }
    } else if (ev.type === 'result') {
      if (ev.modelUsage && lastContextUsage) {
        const mu = Object.values(ev.modelUsage)[0];
        if (mu?.inputTokens != null && mu?.contextWindow != null) {
          lastContextUsage.set({
            used: mu.inputTokens,
            total: mu.contextWindow,
            cacheRead: mu.cacheReadInputTokens ?? 0,
            out: mu.outputTokens ?? 0,
          });
        }
      }
    }
  }

  function applyLines(lines) { resetTurnState(); for (const l of lines) parseLine(l); }
  return { parseLine, applyLines };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
}

function approx(a, b, tol = 1) { return Math.abs(a - b) <= tol; }

// ── test data ─────────────────────────────────────────────────────────────────

// Simulated session assistant event (stop_reason present = session-complete)
const sessionAssistantLine = JSON.stringify({
  type: 'assistant',
  uuid: 'test-uuid',
  message: {
    id: 'msg_test',
    model: 'claude-sonnet-4-6',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello!' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 500,
      cache_read_input_tokens: 12000,
      cache_creation_input_tokens: 800,
      output_tokens: 42,
    },
  },
});

// Simulated stream assistant event (stop_reason null = partial)
const streamAssistantLine = JSON.stringify({
  type: 'assistant',
  parent_tool_use_id: null,
  session_id: 'sess-1',
  uuid: 'test-uuid-2',
  message: {
    id: 'msg_stream',
    model: 'claude-sonnet-4-6',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Streaming...' }],
    stop_reason: null,  // <-- stream partial
    usage: { input_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});

// Simulated result event (stream-only)
const resultLine = JSON.stringify({
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.0023,
  usage: { input_tokens: 4, cache_read_input_tokens: 28298, output_tokens: 42 },
  modelUsage: {
    'claude-sonnet-4-6': {
      inputTokens: 353,
      outputTokens: 42,
      cacheReadInputTokens: 28298,
      cacheCreationInputTokens: 0,
      contextWindow: 200000,
      costUSD: 0.0023,
    },
  },
});

// ── tests ─────────────────────────────────────────────────────────────────────

// Test 1: Session assistant event sets lastContextUsage
{
  const store = writable(null);
  const p = createParserForTest({ lastContextUsage: store });
  p.parseLine(sessionAssistantLine);
  const val = store.get();
  assert(val !== null, 'T1: lastContextUsage set from session assistant event');
  assert(val.used === 500 + 12000 + 800, 'T1: used = in+cacheRead+cacheCreate = 13300');
  assert(val.total === 200000, 'T1: total = 200000');
  assert(val.cacheRead === 12000, 'T1: cacheRead = 12000');
  assert(val.out === 42, 'T1: out = 42');
  const pct = val.used / val.total * 100;
  assert(approx(pct, 6.65, 0.1), `T1: ctx% ≈ 6.65% (got ${pct.toFixed(2)}%)`);
  const cachePct = Math.round(val.cacheRead / val.used * 100);
  assert(cachePct === 90, `T1: input cache% = 90% (got ${cachePct}%)`);
}

// Test 2: Stream partial assistant event does NOT set lastContextUsage
{
  const store = writable(null);
  const p = createParserForTest({ lastContextUsage: store });
  p.parseLine(streamAssistantLine);
  assert(store.get() === null, 'T2: stream partial does NOT set lastContextUsage');
}

// Test 3: Result event sets lastContextUsage with modelUsage values
{
  const store = writable(null);
  const p = createParserForTest({ lastContextUsage: store });
  p.parseLine(resultLine);
  const val = store.get();
  assert(val !== null, 'T3: lastContextUsage set from result event');
  assert(val.used === 353, 'T3: used = modelUsage.inputTokens = 353');
  assert(val.total === 200000, 'T3: total = contextWindow = 200000');
  assert(val.cacheRead === 28298, 'T3: cacheRead = 28298');
  assert(val.out === 42, 'T3: out = 42');
}

// Test 4: Result event overwrites session assistant value (live turn completes)
{
  const store = writable(null);
  const p = createParserForTest({ lastContextUsage: store });
  p.parseLine(sessionAssistantLine);  // sets from session history
  p.parseLine(resultLine);            // overwrites with live result
  const val = store.get();
  assert(val.used === 353, 'T4: result overwrites session value (used=353)');
  assert(val.total === 200000, 'T4: contextWindow from modelUsage');
}

// Test 5: History replay via applyLines sets lastContextUsage from last assistant
{
  const store = writable(null);
  const p = createParserForTest({ lastContextUsage: store });
  const sessionAssistant2 = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant', content: [{ type: 'text', text: 'Turn 2' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0, output_tokens: 100 },
    },
  });
  p.applyLines([sessionAssistantLine, sessionAssistant2]);
  const val = store.get();
  // Last event wins: 1000+20000+0 = 21000
  assert(val.used === 21000, 'T5: applyLines sets from last assistant event (21000)');
  assert(val.out === 100, 'T5: out from last turn');
}

console.log('\nAll tests passed.');

// ── summarize.js tests ────────────────────────────────────────────────────────
// Inline summarize logic for testing (avoids import complexity)
const TRUNC = 500, TRUNC_RESULT = 100;
function truncStr(s, limit = TRUNC) {
  return s.length > limit ? s.slice(0, limit) + `…[+${s.length - limit} chars]` : s;
}
function summarizeOldLines(lines) {
  let lastCompleteAsstIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.type === 'assistant' && ev.message?.stop_reason != null && ev.message?.usage) {
        lastCompleteAsstIdx = i; break;
      }
    } catch {}
  }
  let seenAiTitle = false;
  return lines.flatMap((line, idx) => {
    let ev; try { ev = JSON.parse(line); } catch { return [line]; }
    if (ev.type === 'ai-title') { if (!seenAiTitle) { seenAiTitle = true; return [line]; } return []; }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const content = ev.message.content.flatMap(b => {
        if (b.type === 'thinking') return [];
        return [b];
      });
      const { id, role, stop_reason, stop_sequence, type: msgType, usage } = ev.message;
      const msg = { id, role, stop_reason, stop_sequence, type: msgType, content };
      if (idx === lastCompleteAsstIdx && usage) msg.usage = usage;
      return [JSON.stringify({ type: ev.type, timestamp: ev.timestamp, message: msg })];
    }
    return [line];
  });
}

// Test S1: summarize strips usage from all but last complete assistant event
{
  const mkAsst = (n, sr, usage) => JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_' + n, role: 'assistant', type: 'message',
      content: [{ type: 'text', text: 'hello ' + n }],
      stop_reason: sr,
      usage,
    },
  });
  const usage1 = { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 20 };
  const usage2 = { input_tokens: 200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 30 };
  const lines = [
    mkAsst(1, 'end_turn', usage1),  // older — usage should be stripped
    mkAsst(2, 'end_turn', usage2),  // most recent — usage should be kept
  ];
  const out = summarizeOldLines(lines).map(l => JSON.parse(l));
  assert(!('usage' in out[0].message), 'S1: older assistant event has usage stripped');
  assert('usage' in out[1].message, 'S1: most recent assistant event keeps usage');
  assert(out[1].message.usage.output_tokens === 30, 'S1: kept usage values correct');
}

// Test S2: stream partial events (stop_reason null) never keep usage
{
  const mkStream = (n) => JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_s' + n, role: 'assistant', type: 'message',
      content: [{ type: 'text', text: 'partial ' + n }],
      stop_reason: null,
      usage: { input_tokens: 4, output_tokens: 0 },
    },
  });
  const lines = [mkStream(1), mkStream(2)];
  const out = summarizeOldLines(lines).map(l => JSON.parse(l));
  assert(!('usage' in out[0].message), 'S2: stream partial 1 has no usage');
  assert(!('usage' in out[1].message), 'S2: stream partial 2 has no usage');
}
