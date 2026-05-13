<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import Self from './TreeLevel.svelte';

  let { entries = [], treeNodes = {}, indent = 0, onToggleDir, onOpenFile } = $props();
</script>

{#each entries as entry (entry.path)}
  {#if entry.isDir}
    {@const node = treeNodes[entry.path]}
    {@const isOpen = node?.open && !node?.loading}
    <button
      class="node dir"
      style="padding-left: {12 + indent * 12}px"
      onclick={() => onToggleDir?.(entry.path)}
      title={entry.path}
    >
      <span class="icon">{isOpen ? '▼' : '▶'}</span>
      <span class="name">{entry.name}</span>
      {#if node?.loading}<span class="spin">…</span>{/if}
    </button>

    {#if isOpen && node?.entries}
      <Self
        entries={node.entries}
        {treeNodes}
        indent={indent + 1}
        {onToggleDir}
        {onOpenFile}
      />
    {/if}
  {:else}
    <button
      class="node file"
      style="padding-left: {12 + indent * 12}px"
      onclick={() => onOpenFile?.(entry.path)}
      title={entry.path}
    >
      <span class="name">{entry.name}</span>
    </button>
  {/if}
{/each}

<style>
  .node {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-dim);
    font: inherit;
    font-size: .75rem;
    text-align: left;
    padding-top: 2px;
    padding-bottom: 2px;
    padding-right: 8px;
    transition: color .1s, background .1s;
    white-space: nowrap;
    overflow: hidden;
  }
  .node:hover {
    color: var(--text);
    background: var(--bg-elevated);
  }
  .node.file:hover {
    color: var(--accent-light);
  }
  .icon {
    font-size: .55rem;
    color: var(--text-dim);
    flex-shrink: 0;
    width: 10px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }
  .spin {
    color: var(--text-dim);
    font-size: .65rem;
    flex-shrink: 0;
  }
</style>
