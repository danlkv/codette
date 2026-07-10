// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Input-bar command dispatch, per doc/main.spec.md "Slash commands".
// Pure decisions only — execution lives in ChatLayout.

// Codette commands: view kind handled in the client, action kind sends a
// prompt to the agent. Suggestions merge these with the backend registry.
export const CODETTE_COMMANDS = [
  { cmd: '/codette-status',       kind: 'view',   desc: 'host/ws connection status' },
  { cmd: '/codette-inline-files', kind: 'action', desc: 'send inline-file-viewer prompt' },
  { cmd: '/codette-html-render',  kind: 'action', desc: 'send HTML-render prompt' },
];

// SDK-mapped commands: Claude Code commands the sdk backend removes from its
// registry in favor of a dedicated method; intercepted only when absent from
// the active registry.
export const SDK_MAPPED = [
  { cmd: '/model', event: 'set_model', argKey: 'model',
    args: ['default', 'sonnet', 'opus', 'haiku'],
    desc: 'switch model', hint: 'usage: /model <alias|model-id>' },
];

/**
 * Decide what to do with input-bar text.
 * @param {string} text
 * @param {{registry: string[]}} ctx - registry: active backend's slash_commands
 * @returns {{kind:'codette',name,arg} | {kind:'agent_ctl',event,...} |
 *           {kind:'hint',text} | {kind:'passthrough'} | {kind:'message'}}
 */
export function decide(text, { registry = [] } = {}) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'message' };

  const [head, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(' ');

  const codette = CODETTE_COMMANDS.find(c => c.cmd === head);
  if (codette) return { kind: 'codette', name: head.slice(1), arg };

  const mapped = SDK_MAPPED.find(c => c.cmd === head);
  if (mapped && !registry.includes(head.slice(1))) {
    if (!arg) return { kind: 'hint', text: mapped.hint };
    return { kind: 'agent_ctl', event: mapped.event, [mapped.argKey]: arg };
  }

  return { kind: 'passthrough' };
}
