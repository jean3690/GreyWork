<script setup lang="ts">
/**
 * viewer 异步 chunk 加载期间的骨架占位。
 *
 * 只管「代码块还在下载」这一阶段（defineAsyncComponent 的 loadingComponent），
 * 各 viewer 内部的「读取中…」（内容读取）是另一个阶段，由它们自己表达。
 * `delay` 由 PreviewSurface 的 makeViewer 统一定为 200ms：快速切 tab 时
 * chunk 早已缓存，骨架闪一下反而比没有更吵。
 */
const BAR_WIDTHS = ["w-3/4", "w-full", "w-5/6", "w-2/3", "w-11/12", "w-1/2"];
</script>

<template>
  <div data-testid="preview-skeleton" class="flex size-full flex-col gap-3 overflow-hidden p-4" aria-hidden="true">
    <span v-for="(bar, index) in BAR_WIDTHS" :key="index" class="h-3 animate-pulse rounded-[4px] bg-panel" :class="bar" />
  </div>
</template>
