// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { get } from 'svelte/store';
import { toolSummary } from '../utils/tools.js';

/**
 * createParser({ messages, currentSessionId, lastCost, lastUsage })
 *
 * Returns { parseLine, resetTurnState, finalizeIncomplete, applyLines }.
 *
 * - parseLine(line, live): process one raw JSONL string; updates messages store directly.
 * - applyLines(lines): process a batch atomically; returns the resulting messages array
 *   (caller should call messages.set(result)).
 * - resetTurnState / finalizeIncomplete: lifecycle helpers for callers.
 */
export function createParser({ messages, currentSessionId, lastCost, lastUsage }) {
  // Per-turn streaming state
  let seenToolIds = new Set();
  let liveClaudeId = null;
  let liveUid = null;
  let msgCounter = 0;

  // Batch accumulator: null = write to store directly, array = accumulate for atomic set
  let _batch = null;

  const uid = () => ++msgCounter;

  const mutMsg = fn => {
    if (_batch !== null) { _batch = fn(_batch); }
    else { messages.update(fn); }
  };

  function resetTurnState() {
    seenToolIds = new Set(); liveClaudeId = null; liveUid = null;
  }

  function finalizeIncomplete() {
    if (liveUid !== null) {
      mutMsg(ms => ms.map(m => m.id === liveUid ? { ...m, streaming: false } : m));
    }
    mutMsg(ms => ms.map(m => m.running ? { ...m, running: false } : m));
    resetTurnState();
  }

  function commitTool(b) {
    if (b.name === 'AskUserQuestion') {
      mutMsg(ms => [...ms, {
        id: uid(), role: 'user_question',
        toolId: b.id, questions: b.input?.questions ?? [],
      }]);
    } else if (b.name === 'TodoWrite') {
      mutMsg(ms => [...ms, {
        id: uid(), role: 'todo',
        toolId: b.id, todos: b.input?.todos ?? [],
      }]);
    } else {
      mutMsg(ms => [...ms, {
        id: uid(), role: 'tool',
        toolId: b.id, name: b.name,
        input: b.input, summary: toolSummary(b.name, b.input),
        running: true,
      }]);
    }
  }

  function parseLine(line, live = false) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }

    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      if (!get(currentSessionId)) currentSessionId.set(ev.session_id);
      return;
    }

    if (ev.type === 'user') {
      const content = ev.message?.content;
      if (typeof content === 'string' && content.trim()) {
        mutMsg(ms => [...ms, { id: uid(), role: 'user', text: content, ts: ev.timestamp ?? null }]);
      } else if (Array.isArray(content)) {
        const RESULT_CAP = 2000;
        const results = content
          .filter(b => b.type === 'tool_result')
          .map(b => {
            const raw = b.content;
            const full = typeof raw === 'string' ? raw
              : Array.isArray(raw) ? raw.filter(c => c.type === 'text').map(c => c.text).join('') : '';
            const capped = full.length > RESULT_CAP;
            const text = capped ? full.slice(0, RESULT_CAP) + '\n…' : full;
            return { id: b.tool_use_id, result: { text, total: full.length, capped } };
          });
        if (results.length) mutMsg(ms => ms.map(m => {
          const r = results.find(r => r.id === m.toolId);
          return m.role === 'tool' && r ? { ...m, running: false, result: r.result } : m;
        }));
      }
      return;
    }

    if (ev.type === 'user_message') {
      mutMsg(ms => [...ms, { id: uid(), role: 'user', text: ev.text, ts: ev.timestamp ?? null }]);
      return;
    }

    if (ev.type === 'assistant') {
      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      const claudeId = ev.message?.id ?? null;

      let text = '';
      for (const b of content) {
        if (b.type === 'text') text += b.text;
      }

      if (text) {
        if (claudeId && claudeId === liveClaudeId && liveUid !== null) {
          mutMsg(ms => ms.map(m =>
            m.id === liveUid ? { ...m, text } : m
          ));
        } else {
          if (liveUid !== null) {
            mutMsg(ms => ms.map(m =>
              m.id === liveUid ? { ...m, streaming: false } : m
            ));
          }
          liveClaudeId = claudeId;
          liveUid = uid();
          mutMsg(ms => [...ms, { id: liveUid, role: 'assistant', text, streaming: live, ts: ev.timestamp ?? null }]);
        }
      }

      for (const b of content) {
        if (b.type === 'tool_use' && !seenToolIds.has(b.id)) {
          seenToolIds.add(b.id);
          commitTool(b);
        }
      }

    } else if (ev.type === 'result') {
      if (liveUid !== null) {
        mutMsg(ms => ms.map(m =>
          m.id === liveUid ? { ...m, streaming: false } : m
        ));
        liveUid = null;
        liveClaudeId = null;
      }
      mutMsg(ms => ms.map(m =>
        m.role === 'tool' && m.running ? { ...m, running: false } : m
      ));
      if (ev.total_cost_usd != null) lastCost.set(ev.total_cost_usd);
      if (ev.usage != null) lastUsage.set(ev.usage);
      seenToolIds = new Set();
    }
  }

  // Process lines atomically; returns the resulting messages array.
  // Caller should call messages.set(result).
  function applyLines(lines) {
    _batch = [];
    resetTurnState();
    for (const line of lines) parseLine(line, false);
    finalizeIncomplete();
    const batch = _batch;
    _batch = null;
    return batch;
  }

  return { parseLine, resetTurnState, finalizeIncomplete, applyLines };
}
