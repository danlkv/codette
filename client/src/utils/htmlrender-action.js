// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { mount } from 'svelte';
import HtmlRender from '../lib/HtmlRender.svelte';
import { htmlRenderStore } from './markdown.js';

export function htmlRenderAction(node, param) {
  function run() {
    for (const el of node.querySelectorAll('.html-render-block:not([data-mounted])')) {
      el.dataset.mounted = '1';
      const id = el.dataset.hrid;
      const html = id ? htmlRenderStore.get(id) : null;
      if (!html) continue;
      mount(HtmlRender, { target: el, props: { html } });
    }
  }
  setTimeout(run, 0);
  return { update() { setTimeout(run, 0); } };
}
