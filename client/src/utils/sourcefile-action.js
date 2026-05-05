// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { mount } from 'svelte';
import SourceFileBlock from '../lib/SourceFileBlock.svelte';

function parseRanges(str) {
  if (!str) return [];
  return str.split(',').map(r => {
    const [s, e] = r.split('-');
    return { start: +s, end: e ? +e : +s };
  }).filter(r => r.start > 0);
}

export function sourceFileRender(node, trigger) {
  function run() {
    const { sessionId, token, onOpenFile } = trigger ?? {};
    for (const el of node.querySelectorAll('.source-file-block:not([data-mounted])')) {
      el.dataset.mounted = '1';
      const { path, ranges, ann } = el.dataset;
      mount(SourceFileBlock, {
        target: el,
        props: {
          path,
          ranges: parseRanges(ranges),
          annotations: ann ? JSON.parse(ann) : [],
          sessionId,
          token,
          onOpenFile: onOpenFile ? () => onOpenFile(path) : null,
        },
      });
    }
  }
  setTimeout(run, 0);
  return { update(t) { trigger = t; setTimeout(run, 0); } };
}
