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
export function createParser({ messages, currentSessionId, lastCost, lastUsage, lastContextUsage, onContextWindow, slashRegistry = null }) {
  // Per-turn streaming state
  let seenToolIds = new Set();
  let liveClaudeId = null;
  let liveUid = null;
  let msgCounter = 0;
  let lastAssistantUsage = null; // last seen assistant message usage (any stop_reason)

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
    const base = { id: uid(), role: 'tool', toolId: b.id, name: b.name, input: b.input };
    if (b.name === 'AskUserQuestion') {
      mutMsg(ms => [...ms, { ...base, kind: 'question', questions: b.input?.questions ?? [] }]);
    } else if (b.name === 'TodoWrite') {
      mutMsg(ms => [...ms, { ...base, kind: 'todo', todos: b.input?.todos ?? [] }]);
    } else if (b.name === 'ExitPlanMode') {
      // Find the plan .md file from the most recent Write tool_use in this turn
      const cur = _batch !== null ? _batch : get(messages);
      const writeMsg = [...cur].reverse().find(m => m.role === 'tool' && m.name === 'Write' && m.input?.file_path?.includes('/plans/'));
      const planFile = writeMsg?.input?.file_path ?? null;
      mutMsg(ms => [...ms, { ...base, kind: 'plan', planFile }]);
    } else {
      mutMsg(ms => [...ms, { ...base, kind: 'regular', summary: toolSummary(b.name, b.input), running: true }]);
    }
  }

  function parseLine(line, live = false) {
    const fromHistory = !live;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }

    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      if (!get(currentSessionId)) currentSessionId.set(ev.session_id);
      if (slashRegistry && Array.isArray(ev.slash_commands)) slashRegistry.set(ev.slash_commands);
      return;
    }

    // Local-command artifacts (see doc/main.spec.md "Slash commands").
    if (ev.type === 'system' && ev.subtype === 'local_command') {
      const out = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/.exec(ev.content ?? '');
      const text = (out ? out[1] : String(ev.content ?? '')).trim();
      if (text) mutMsg(ms => [...ms, { id: uid(), role: 'system', text }]);
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'status') {
      let text = null;
      if (ev.status === 'compacting') text = 'compacting…';
      else if (ev.compact_result === 'success') text = 'compacted';
      else if (ev.compact_result === 'failed') text = `compact failed: ${ev.compact_error ?? 'unknown error'}`;
      if (text) mutMsg(ms => [...ms, { id: uid(), role: 'system', text }]);
      return;
    }

    if (ev.type === 'user') {
      const content = ev.message?.content;
      if (typeof content === 'string' && content.includes('<local-command-caveat>')) return;
      if (typeof content === 'string' && content.includes('<command-name>')) {
        const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(content)?.[1]?.trim() ?? '';
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1]?.trim() ?? '';
        const text = args ? `${name} ${args}` : name;
        if (text) mutMsg(ms => [...ms, { id: uid(), role: 'user', text, isCommand: true, ts: ev.timestamp ?? null }]);
        return;
      }
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
            return { id: b.tool_use_id, isError: !!b.is_error, result: { text, total: full.length, capped } };
          });
        if (results.length) mutMsg(ms => ms.map(m => {
          const r = results.find(r => r.id === m.toolId);
          if (!(m.role === 'tool' && r)) return m;
          const update = { ...m, running: false, result: r.result };
          // Infer permission outcome for interactive tools when replaying history.
          // tool_result with is_error means denied; otherwise approved.
          if (m.kind === 'plan' || m.kind === 'question') {
            update.resolved = true;
            update.decision = r.isError ? 'denied' : 'allowed';
          }
          // Detect denied regular tools from SDK rejection boilerplate
          if (m.kind === 'regular' && r.isError && r.result?.text?.includes('tool use was rejected')) {
            update.kind = 'permission';
            update.resolved = true;
            update.decision = 'denied';
          }
          // Restore selected answers for questions from tool_result content.
          // SDK format: 'Your questions have been answered: "Q1"="A1", "Q2"="A2"'
          // or JSON {questions, answers} from our own updatedInput merge.
          if (m.kind === 'question' && !r.isError && r.result?.text) {
            const txt = r.result.text;
            try {
              const data = JSON.parse(txt);
              if (data.answers) update.answers = data.answers;
            } catch {
              // Parse SDK human-readable format: "question"="answer"
              const answers = {};
              for (const m2 of txt.matchAll(/"([^"]+)"="([^"]+)"/g)) {
                answers[m2[1]] = m2[2];
              }
              if (Object.keys(answers).length) update.answers = answers;
            }
          }
          return update;
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
          mutMsg(ms => [...ms, { id: liveUid, role: 'assistant', text, streaming: live, ts: ev.timestamp ? new Date(ev.timestamp).getTime() : Date.now() }]);
        }
      }

      for (const b of content) {
        if (b.type === 'tool_use' && !seenToolIds.has(b.id)) {
          seenToolIds.add(b.id);
          commitTool(b);
        }
      }

      // Update ctx from assistant events (both history and live).
      // usage.input_tokens + cache fields = tokens sent to this API call = current context size.
      // result.modelUsage has cumulative billing totals, not per-call context size.
      const stopReason = ev.message?.stop_reason;
      const usage = ev.message?.usage;
      if (usage) lastAssistantUsage = usage; // track last seen usage for result handler fallback
      if (stopReason != null && usage && lastContextUsage) {
        const inputTotal = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const val = {
          used: inputTotal,
          total: 200000, // all current Claude models; overwritten when result event provides contextWindow
          cacheRead: usage.cache_read_input_tokens ?? 0,
          out: usage.output_tokens ?? 0,
        };
        lastContextUsage.set(val);
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
      // Local commands complete with num_turns 0 — no model call, nothing to bill.
      const isLocalTurn = ev.num_turns === 0;
      if (!isLocalTurn && ev.total_cost_usd != null) lastCost.set(ev.total_cost_usd);
      if (!isLocalTurn && ev.usage != null) lastUsage.set(ev.usage);
      // result.modelUsage provides the definitive contextWindow (denominator).
      // Use lastAssistantUsage for per-call token counts — result.usage is cumulative across turns.
      // With --include-partial-messages, the final complete assistant event may not reach the live
      // stream (only partials do), so this is the reliable place to set lastContextUsage live.
      if (lastContextUsage) {
        const cw = ev.modelUsage
          ? Object.values(ev.modelUsage).map(m => m.contextWindow).find(v => v != null)
          : null;
        if (lastAssistantUsage) {
          const u = lastAssistantUsage;
          const inputTotal = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          lastContextUsage.set({
            used: inputTotal,
            total: cw ?? 200000,
            cacheRead: u.cache_read_input_tokens ?? 0,
            out: u.output_tokens ?? 0,
          });
          if (cw != null) onContextWindow?.(cw);
        } else if (cw != null) {
          lastContextUsage.update(v => v ? { ...v, total: cw } : v);
          onContextWindow?.(cw);
        }
        lastAssistantUsage = null; // reset for next turn
      }
      seenToolIds = new Set();
    }
  }

  // Process lines atomically; returns the resulting messages array.
  // Caller should call messages.set(result).
  function applyLines(lines) {
    _batch = [];
    resetTurnState();
    // Debug: tally event types and assistant stop_reasons
    const tally = {}; const asstReasons = {};
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        tally[ev.type] = (tally[ev.type] ?? 0) + 1;
        if (ev.type === 'assistant') {
          const sr = ev.message?.stop_reason ?? 'null/absent';
          asstReasons[sr] = (asstReasons[sr] ?? 0) + 1;
        }
      } catch {}
    }
    for (const line of lines) parseLine(line, false);
    finalizeIncomplete();
    const batch = _batch;
    _batch = null;
    return batch;
  }

  return { parseLine, resetTurnState, finalizeIncomplete, applyLines };
}
