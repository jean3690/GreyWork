<script setup lang="ts">
/**
 * 预览内容区：按 tab.kind 分派到具体 viewer。
 *
 * 每个 viewer 都是 `defineAsyncComponent` —— Univer 三件套和 pdfjs 都是重包，
 * 同步 import 会把它们焊进主 chunk，让一个从不打开 xlsx 的用户也付启动代价。
 * 分派表在这里集中，viewer 只需实现 `{ tab }` 一个 prop。
 */
import { computed, defineAsyncComponent, type Component } from "vue";
import type { ViewerKind } from "../../lib/viewer";
import type { PreviewTab } from "../../stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const VIEWERS: Record<ViewerKind, Component> = {
  md: defineAsyncComponent(() => import("./MarkdownViewer.vue")),
  html: defineAsyncComponent(() => import("./HtmlViewer.vue")),
  csv: defineAsyncComponent(() => import("./TableViewer.vue")),
  code: defineAsyncComponent(() => import("./TextViewer.vue")),
  raw: defineAsyncComponent(() => import("./TextViewer.vue")),
  image: defineAsyncComponent(() => import("./ImageViewer.vue")),
  xlsx: defineAsyncComponent(() => import("./SheetViewer.vue")),
  docx: defineAsyncComponent(() => import("./DocViewer.vue")),
  pptx: defineAsyncComponent(() => import("./SlideViewer.vue")),
  pdf: defineAsyncComponent(() => import("./PdfViewer.vue")),
  diff: defineAsyncComponent(() => import("./DiffViewer.vue")),
  web: defineAsyncComponent(() => import("./WebPageViewer.vue")),
};

const viewer = computed(() => VIEWERS[props.tab.kind]);
</script>

<template>
  <!-- key 用 tab.id：切 tab 必须换实例，否则 Univer / CodeMirror 会把上一份文档留在容器里 -->
  <component :is="viewer" :key="props.tab.id" :tab="props.tab" class="size-full" />
</template>
