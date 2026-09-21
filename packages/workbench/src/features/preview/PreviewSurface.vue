<script setup lang="ts">
/**
 * 预览内容区：按 tab.kind 分派到具体 viewer。
 *
 * 每个 viewer 都是 `defineAsyncComponent` —— Univer 三件套和 pdfjs 都是重包，
 * 同步 import 会把它们焊进主 chunk，让一个从不打开 xlsx 的用户也付启动代价。
 * 分派表在这里集中，viewer 只需实现 `{ tab }` 一个 prop。
 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import PreviewSkeleton from "@/features/preview/PreviewSkeleton.vue";
import SelectionLayer from "@/features/preview/SelectionLayer.vue";
import { isTextSelectableKind } from "@/lib/selection";
import { recallPixelScroll, rememberPixelScroll } from "@/lib/preview-scroll";
import type { ViewerKind } from "@/lib/viewer";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

/**
 * 带骨架屏的异步 viewer：chunk 下载期间显示 PreviewSkeleton（200ms 内 resolve
 * 不显示，避免快速切 tab 时骨架闪烁）。每个 lang/渲染包仍是独立 chunk，重包
 * 不进主包的分包策略不变。
 */
const makeViewer = (loader: () => Promise<Component>): Component =>
  defineAsyncComponent({ loader, loadingComponent: PreviewSkeleton, delay: 200 });

const VIEWERS: Record<ViewerKind, Component> = {
  md: makeViewer(() => import("@/features/preview/MarkdownViewer.vue")),
  html: makeViewer(() => import("@/features/preview/HtmlViewer.vue")),
  csv: makeViewer(() => import("@/features/preview/TableViewer.vue")),
  code: makeViewer(() => import("@/features/preview/TextViewer.vue")),
  raw: makeViewer(() => import("@/features/preview/TextViewer.vue")),
  image: makeViewer(() => import("@/features/preview/ImageViewer.vue")),
  xlsx: makeViewer(() => import("@/features/preview/SheetViewer.vue")),
  xls: makeViewer(() => import("@/features/preview/LegacySheetViewer.vue")),
  docx: makeViewer(() => import("@/features/preview/DocViewer.vue")),
  pptx: makeViewer(() => import("@/features/preview/SlideViewer.vue")),
  pdf: makeViewer(() => import("@/features/preview/PdfViewer.vue")),
  "legacy-office": makeViewer(() => import("@/features/preview/LegacyOfficeViewer.vue")),
  diff: makeViewer(() => import("@/features/preview/DiffViewer.vue")),
  web: makeViewer(() => import("@/features/preview/WebPageViewer.vue")),
};

const viewer = computed(() => VIEWERS[props.tab.kind]);

/**
 * 是否挂划词层。
 *
 * 除「本来就没有可选文本」的 kind 外，分析模式也要放行：xlsx 的表格模式是 Univer canvas
 * （拿不到 DOM 文本，见 lib/selection.ts），但分析模式渲染的是真实 `<table>`，划词完全可用。
 * 这里必须按模式**显式开门**，不能靠「不挂」来回避 —— `SelectionLayer.resolveScope()` 在
 * 找不到 `[data-selection-scope]` 时会回退到 root 本身，于是整个面板都会变成作用域。
 */
const textSelectable = computed(() => isTextSelectableKind(props.tab.kind) || props.tab.mode === "analysis");

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
