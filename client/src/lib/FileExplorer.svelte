<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  import TreeLevel from './TreeLevel.svelte';

  let { sessionId = null, sessionCwd = null, token = null, onFileOpen } = $props();

  let sectionOpen = $state(localStorage.getItem('claudeweb_fileExplorer') !== 'false');
  $effect(() => { localStorage.setItem('claudeweb_fileExplorer', sectionOpen ? 'true' : 'false'); });
  let treeNodes = $state({});

  let cwdBasename = $derived(sessionCwd ? (sessionCwd.split('/').filter(Boolean).pop() || sessionCwd) : '');

  // Reset when sessionId changes
  let prevSessionId = null;
  $effect(() => {
    if (sessionId !== prevSessionId) {
      prevSessionId = sessionId;
      treeNodes = {};
      if (sessionCwd && sectionOpen) {
        loadDir(sessionCwd);
      }
    }
  });

  // Auto-load root when section opens or cwd changes
  $effect(() => {
    if (sessionCwd && sectionOpen && !treeNodes[sessionCwd]) {
      loadDir(sessionCwd);
    }
  });

  async function loadDir(path) {
    if (!sessionId || !token || !path) return;
    if (treeNodes[path]?.loading) return;

    treeNodes = {
      ...treeNodes,
      [path]: { entries: treeNodes[path]?.entries ?? [], open: true, loading: true, error: null },
    };

    try {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/fs?path=${encodeURIComponent(path)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text();
        treeNodes = {
          ...treeNodes,
          [path]: { ...treeNodes[path], loading: false, error: `Error ${res.status}: ${text}` },
        };
        return;
      }
      const data = await res.json();
      treeNodes = {
        ...treeNodes,
        [path]: { entries: data.entries ?? [], open: true, loading: false, error: null },
      };
    } catch (e) {
      treeNodes = {
        ...treeNodes,
        [path]: { ...treeNodes[path], loading: false, error: String(e) },
      };
    }
  }

  function toggleSection() {
    sectionOpen = !sectionOpen;
    if (sectionOpen && sessionCwd && !treeNodes[sessionCwd]) {
      loadDir(sessionCwd);
    }
  }

  function handleToggleDir(path) {
    const node = treeNodes[path];
    if (!node || (!node.entries.length && !node.loading && !node.error)) {
      loadDir(path);
      return;
    }
    treeNodes = {
      ...treeNodes,
      [path]: { ...node, open: !node.open },
    };
  }

  function handleOpenFile(path) {
    onFileOpen?.({ sessionId, path });
  }
</script>

{#if sessionCwd}
  <div class="file-explorer">
    <button class="fe-header" onclick={toggleSection}>
      <span class="toggle">{sectionOpen ? '▼' : '▶'}</span>
      <span class="label">Files</span>
      <span class="cwd-name">{cwdBasename}</span>
    </button>

    {#if sectionOpen}
      <div class="tree">
        {#if !treeNodes[sessionCwd]}
          <span class="info">loading…</span>
        {:else if treeNodes[sessionCwd].loading && !treeNodes[sessionCwd].entries.length}
          <span class="info">loading…</span>
        {:else if treeNodes[sessionCwd].error}
          <span class="err">{treeNodes[sessionCwd].error}</span>
        {:else}
          <TreeLevel
            entries={treeNodes[sessionCwd].entries}
            {treeNodes}
            indent={0}
            onToggleDir={handleToggleDir}
            onOpenFile={handleOpenFile}
          />
          {#if treeNodes[sessionCwd].entries.length === 0}
            <span class="info">empty directory</span>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .file-explorer {
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }

  .fe-header {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 7px 12px 5px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font: inherit;
    font-size: .7rem;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    text-align: left;
    transition: color .15s;
  }
  .fe-header:hover { color: var(--text); }

  .toggle {
    font-size: .58rem;
    color: var(--text-dim);
    flex-shrink: 0;
  }
  .label { color: var(--text-muted); }
  .cwd-name {
    color: var(--text-dim);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tree {
    overflow-y: auto;
    max-height: 280px;
    padding-bottom: 6px;
  }

  .info {
    display: block;
    padding: 4px 16px;
    font-size: .72rem;
    color: var(--text-dim);
  }
  .err {
    display: block;
    padding: 4px 16px;
    font-size: .72rem;
    color: var(--error);
    word-break: break-all;
  }
</style>
