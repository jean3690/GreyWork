<script setup lang="ts">
/**
 * 预览内容区：按 tab.kind 分派到具体 viewer。
 *
 * 每个 viewer 都是 `defineAsyncComponent` —— Univer 三件套和 pdfjs 都是重包，
 * 同步 import 会把它们焊进主 chunk，让一个从不打开 xlsx 的用户也付启动代价。
 * 分派表在这里集中，viewer 只需实现 `{ tab }` 一个 prop。
 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import SelectionLayer from "@/features/preview/SelectionLayer.vue";
import { isTextSelectableKind } from "@/lib/selection";
import { recallPixelScroll, rememberPixelScroll } from "@/lib/preview-scroll";
import type { ViewerKind } from "@/lib/viewer";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const VIEWERS: Record<ViewerKind, Component> = {
  md: defineAsyncComponent(() => import("@/features/preview/MarkdownViewer.vue")),
  html: defineAsyncComponent(() => import("@/features/preview/HtmlViewer.vue")),
  csv: defineAsyncComponent(() => import("@/features/preview/TableViewer.vue")),
  code: defineAsyncComponent(() => import("@/features/preview/TextViewer.vue")),
  raw: defineAsyncComponent(() => import("@/features/preview/TextViewer.vue")),
  image: defineAsyncComponent(() => import("@/features/preview/ImageViewer.vue")),
  xlsx: defineAsyncComponent(() => import("@/features/preview/SheetViewer.vue")),
  docx: defineAsyncComponent(() => import("@/features/preview/DocViewer.vue")),
  pptx: defineAsyncComponent(() => import("@/features/preview/SlideViewer.vue")),
  pdf: defineAsyncComponent(() => import("@/features/preview/PdfViewer.vue")),
  "legacy-office": defineAsyncComponent(() => import("@/features/preview/LegacyOfficeViewer.vue")),
  diff: defineAsyncComponent(() => import("@/features/preview/DiffViewer.vue")),
  web: defineAsyncComponent(() => import("@/features/preview/WebPageViewer.vue")),
};

const viewer = computed(() => VIEWERS[props.tab.kind]);

/** 只有能拿到 DOM 文本的渲染器才挂划词层（canvas 类见 lib/selection.ts 的说明）。 */
const textSelectable = computed(() => isTextSelectableKind(props.tab.kind));

/** 划词层的作用域容器：它在事件里惰性查 `[data-selection-scope]`，不追各个 viewer 的根。 */
const surfaceEl = ref<HTMLElement | null>(null);

/**
 * 滚动位置保持：切 tab / 切到文件区都会销毁重建 viewer，scrollTop 随之清零。
 *
 * **保存**靠 `data-scroll-root` 契约找到滚动容器（与 `data-selection-scope` 同一思路），
 * 在 tab 切换的 **pre-flush** watch 里读 —— 那一刻旧 viewer 的 DOM 还在，scrollTop 是准的；
 * 面板整个卸载（切到文件区 / 关面板）走 `onBeforeUnmount`，此刻子 viewer 也还没卸。
 *
 * **恢复**要等：viewer 是异步组件、内容也是异步渲染的，滚动容器出现且真的可滚之前，
 * 写 scrollTop 会被浏览器按当前内容高度收敛掉。所以轮询到「可滚」再还，有界（约 1.8s），
 * 超时放弃 —— 宁可回到顶部，也不要一个永远在跑的定时器。
 */
function saveScrollOf(tabId: string): void {
  const scroller = surfaceEl.value?.querySelector<HTMLElement>("[data-scroll-root]");
  if (scroller) rememberPixelScroll(tabId, scroller.scrollTop);
}

let restoreToken = 0;

async function restoreScroll(tabId: string): Promise<void> {
  const token = ++restoreToken;
  const target = recallPixelScroll(tabId);
  const root = surfaceEl.value;
  if (target === null || target <= 0 || !root) return;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (token !== restoreToken) return; // tab 又切了，这轮作废
    const scroller = root.querySelector<HTMLElement>("[data-scroll-root]");
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      scroller.scrollTop = target;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

watch(
  () => props.tab.id,
  (_next, previous) => {
    if (previous != null) saveScrollOf(previous);
    void restoreScroll(_next);
  },
  { flush: "pre" },
);

onMounted(() => void restoreScroll(props.tab.id));
onBeforeUnmount(() => saveScrollOf(props.tab.id));
</script>

<template>
  <div ref="surfaceEl" class="relative size-full min-h-0">
    <!-- key 用 tab.id：切 tab 必须换实例，否则 Univer / CodeMirror 会把上一份文档留在容器里 -->
    <component :is="viewer" :key="props.tab.id" :tab="props.tab" class="size-full" />
    <!-- key 同 tab.id：换 tab 时重建划词层，顺带把还挂着的浮层清掉 -->
    <SelectionLayer v-if="textSelectable" :key="props.tab.id" :tab="props.tab" :root="surfaceEl" />
  </div>
</template>
