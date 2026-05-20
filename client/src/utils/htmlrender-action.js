// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { mount } from 'svelte';
import HtmlRender from '../lib/HtmlRender.svelte';

export function htmlRenderAction(node) {
  function run() {
    for (const el of node.querySelectorAll('.html-render-block:not([data-mounted])')) {
      el.dataset.mounted = '1';
      const html = el.dataset.html;
      if (!html) continue;
      mount(HtmlRender, {
        target: el,
        props: { html },
      });
    }
  }
  setTimeout(run, 0);
  return { update() { setTimeout(run, 0); } };
}
