// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { mount } from 'svelte';
import HtmlRender from '../lib/HtmlRender.svelte';
import { htmlRenderStore } from './markdown.js';

let _actionN = 0;

export function htmlRenderAction(node, param) {
  const actionId = ++_actionN;
  const msgId = param?.msgId ?? '?';
  let runCount = 0;

  function run(trigger) {
    const blocks = node.querySelectorAll('.html-render-block');
    const unmounted = node.querySelectorAll('.html-render-block:not([data-mounted])');
    console.log(`[hr-action] #${actionId} msg=${msgId} run ${++runCount} (${trigger}): ${blocks.length} total, ${unmounted.length} unmounted, store=${htmlRenderStore.size}`);

    for (const el of unmounted) {
      el.dataset.mounted = '1';
      const id = el.dataset.hrid;
      const html = id ? htmlRenderStore.get(id) : null;
      console.log(`[hr-action] #${actionId} msg=${msgId} mount hrid=${id}, html=${html ? html.length + 'ch' : 'NULL'}`);
      if (!html) continue;
      mount(HtmlRender, {
        target: el,
        props: { html },
      });
    }
  }
  console.log(`[hr-action] #${actionId} msg=${msgId} init`);
  setTimeout(() => run('init'), 0);
  return {
    update(newParam) {
      console.log(`[hr-action] #${actionId} msg=${newParam?.msgId ?? msgId} update`);
      setTimeout(() => run('update'), 0);
    },
  };
}
