// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

export function toolSummary(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Bash': {
      const cmd = input.command || '';
      const first = cmd.split('\n').find(l => l.trim() && !l.trim().startsWith('#'))?.trim() || '';
      if (input.description && (first.length > 60 || cmd.includes('\n'))) {
        return input.description;
      }
      return first.slice(0, 100);
    }
    case 'WebSearch':
    case 'web_search':  return input.query    || '';
    case 'Read':
    case 'Write':
    case 'Edit':        return input.file_path || input.path || '';
    case 'Grep':        return input.pattern   || '';
    case 'LS':          return input.path       || '';
    default: {
      const first = Object.values(input || {})[0];
      return typeof first === 'string' ? first.slice(0, 80) : '';
    }
  }
}

export const TOOL_ICONS = {
  Bash:      '❯',
  Read:      '📄',
  Write:     '✏️',
  Edit:      '✏️',
  Grep:      '🔍',
  WebSearch: '🌐',
  WebFetch:  '🌐',
  LS:        '📂',
};
export function toolIcon(name) {
  return TOOL_ICONS[name] ?? '⚙';
}
