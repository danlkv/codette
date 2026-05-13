<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Danylo Lykov -->

<script>
  let { src, alt = '' } = $props();
</script>

<div class="img-wrap">
  <img class="img-preview" {src} {alt} />
</div>

<style>
  .img-wrap {
    padding: 12px;
    display: flex;
    justify-content: center;
    background: var(--bg-primary);
  }
  .img-preview {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
  }
</style>
