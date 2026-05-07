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
//   - assistant.usage: kept only on the most recent complete event (for ctx bar); stripped elsewhere
export function summarizeOldLines(lines) {
  // Find the last complete assistant event with usage so ctx bar still works after summarization
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
      // strip diagnostics/model + outer transcript metadata; keep usage only on most recent event
      const { id, role, stop_reason, stop_sequence, type: msgType, usage } = ev.message;
      const msg = { id, role, stop_reason, stop_sequence, type: msgType, content };
      if (idx === lastCompleteAsstIdx && usage) msg.usage = usage;
      return [JSON.stringify({ type: ev.type, timestamp: ev.timestamp, message: msg })];
    }

    return [line];
  });
}
