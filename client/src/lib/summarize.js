// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

export const TRUNC = 500;        // chars for assistant text blocks
export const TRUNC_RESULT = 100; // chars for tool result / tool_use input strings
export const KEEP = 100;         // recent lines kept verbatim in tryStoreHistory

function truncStr(s, limit = TRUNC) {
  return s.length > limit ? s.slice(0, limit) + `…[+${s.length - limit} chars]` : s;
}

// Compact old JSONL lines to reduce localStorage size:
//   - user(tool_results): truncate content, strip outer transcript metadata
//   - assistant: drop thinking blocks, truncate text + tool_use inputs, strip outer metadata
export function summarizeOldLines(lines) {
  let seenAiTitle = false;
  return lines.flatMap(line => {
    let ev;
    try { ev = JSON.parse(line); } catch { return [line]; }

    if (ev.type === 'ai-title') {
      if (!seenAiTitle) { seenAiTitle = true; return [line]; }
      return [];
    }

    if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      const content = ev.message.content.map(b => {
        if (b.type !== 'tool_result') return b;
        const raw = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.filter(c => c.type === 'text').map(c => c.text).join('') : null;
        if (raw === null || raw.length <= TRUNC_RESULT) return b;
        return { ...b, content: truncStr(raw, TRUNC_RESULT) };
      });
      // keep only what parser needs; strips toolUseResult, uuid, cwd, etc.
      return [JSON.stringify({ type: ev.type, timestamp: ev.timestamp, message: { ...ev.message, content } })];
    }

    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const content = ev.message.content.flatMap(b => {
        if (b.type === 'thinking') return [];
        if (b.type === 'text' && b.text.length > TRUNC) {
          return [{ ...b, text: truncStr(b.text) }];
        }
        if (b.type === 'tool_use' && b.input) {
          const input = { ...b.input };
          let inputChanged = false;
          for (const [k, v] of Object.entries(input)) {
            if (typeof v === 'string' && v.length > TRUNC_RESULT) {
              input[k] = truncStr(v, TRUNC_RESULT);
              inputChanged = true;
            }
          }
          if (inputChanged) return [{ ...b, input }];
        }
        return [b];
      });
      // strip usage/diagnostics/model + outer transcript metadata
      const { id, role, stop_reason, stop_sequence, type: msgType } = ev.message;
      return [JSON.stringify({ type: ev.type, timestamp: ev.timestamp, message: { id, role, stop_reason, stop_sequence, type: msgType, content } })];
    }

    return [line];
  });
}
