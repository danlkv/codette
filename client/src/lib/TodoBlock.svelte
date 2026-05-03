<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  let { msg } = $props(); // { todos: [{id, content, status, priority}] }

  const STATUS_ICON = { completed: '✓', 'in-progress': '◐', pending: '○' };
  const PRIORITY_COLOR = { high: '#f87171', medium: '#fbbf24', low: '#6b7280' };
</script>

<div class="tblock">
  <div class="theader">
    <span class="icon">☑</span>
    <span class="label">todos</span>
    <span class="count">{msg.todos.length}</span>
  </div>
  <div class="list">
    {#each msg.todos as t, i (t.id ?? i)}
      <div class="item" class:done={t.status === 'completed'}>
        <span class="status">{STATUS_ICON[t.status] ?? '○'}</span>
        <span class="content">{t.content}</span>
        {#if t.priority && t.priority !== 'medium'}
          <span class="priority" style="color:{PRIORITY_COLOR[t.priority] ?? '#6b7280'}">{t.priority}</span>
        {/if}
      </div>
    {/each}
    {#if msg.todos.length === 0}
      <div class="empty">no todos</div>
    {/if}
  </div>
</div>

<style>
  .tblock {
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-secondary);
  }
  .theader {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    font-size: .78rem;
  }
  .icon  { font-size: .9rem; }
  .label { color: var(--accent-light); font-weight: 500; }
  .count {
    margin-left: auto;
    background: var(--bg-secondary); color: var(--text-dim);
    font-size: .7rem; padding: 1px 6px; border-radius: 99px;
  }

  .list { padding: 4px 0; }
  .item {
    display: flex; align-items: baseline; gap: 8px;
    padding: 5px 12px; font-size: .82rem;
  }
  .item:hover { background: var(--bg-elevated); }
  .status  { color: var(--text-dim); flex-shrink: 0; font-size: .78rem; }
  .content { flex: 1; color: var(--text); }
  .item.done .content { color: var(--text-dim); text-decoration: line-through; }
  .priority { font-size: .7rem; flex-shrink: 0; }
  .empty { padding: 8px 12px; color: var(--text-dim); font-size: .8rem; font-style: italic; }
</style>
