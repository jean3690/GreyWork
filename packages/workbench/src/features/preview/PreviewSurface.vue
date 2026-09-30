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
import { cloudOfficeProviderFor } from "@/lib/office-preview";
import { useSettingsStore } from "@/stores/settings";
import { notify } from "@/stores/notice";
import { i18n } from "@/i18n";
import type { ViewerKind } from "@/lib/viewer";
import type { PreviewTab } from "@/stores/preview";

const t = i18n.global.t;

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
  video: makeViewer(() => import("@/features/preview/VideoViewer.vue")),
  "3d": makeViewer(() => import("@/features/preview/ModelViewer.vue")),
  gis: makeViewer(() => import("@/features/preview/MapViewer.vue")),
  xlsx: makeViewer(() => import("@/features/preview/SheetViewer.vue")),
  xls: makeViewer(() => import("@/features/preview/LegacySheetViewer.vue")),
  docx: makeViewer(() => import("@/features/preview/DocViewer.vue")),
  pptx: makeViewer(() => import("@/features/preview/SlideViewer.vue")),
  pdf: makeViewer(() => import("@/features/preview/PdfViewer.vue")),
  "legacy-office": makeViewer(() => import("@/features/preview/LegacyOfficeViewer.vue")),
  diff: makeViewer(() => import("@/features/preview/DiffViewer.vue")),
  web: makeViewer(() => import("@/features/preview/WebPageViewer.vue")),
};

/** 云端 Office viewer：走 `office_preview_open` 让宿主上传取件，再用 iframe 内嵌。 */
const CLOUD_VIEWER = makeViewer(() => import("@/features/preview/CloudOfficeViewer.vue"));

/**
 * 云端 Office 分支：命中时顶掉该 kind 的本地 viewer。
 *
 * **回落是一等公民**：云端任一步失败（没配好、凭证没 export、厂商拒绝、网络不通）都要
 * 回到本地 viewer，而不是给用户一个打不开的文件。回落是**按 tab** 记的（不是全局开关），
 * 一个文件失败不影响其它文件；失败原因同时进通知 —— 回落之后界面上看不出发生过什么，
 * 不告知的话用户只会觉得「配置没生效」，那是这个问题最难排查的形态。
 */
const settings = useSettingsStore();
const cloudFailedTabs = ref(new Set<string>());

const cloudProvider = computed(() => cloudOfficeProviderFor(props.tab, settings.officeProviders, settings.selectedOfficeProviderId));

const activeViewer = computed<Component>(() => {
  if (cloudProvider.value && !cloudFailedTabs.value.has(props.tab.id)) return CLOUD_VIEWER;
  return VIEWERS[props.tab.kind];
});

/**
 * 监听器**只在云端 viewer 上绑**。
 *
 * 本地 viewer 没声明 `fallback` 事件，而它们的根都是单个元素 —— 未声明的监听器会静默降级成
 * 根元素上的原生监听器（`addEventListener("fallback")`），不报警告、也永远不会触发，只是每次
 * 预览都白挂一个。用 `v-on` 传对象而不是模板里写死 `@fallback`，就是为了让它跟着 activeViewer 走。
 */
const viewerListeners = computed(() => (activeViewer.value === CLOUD_VIEWER ? { fallback: onCloudFallback } : {}));

/** 云端失败：切回本地并如实说明原因（同一 tab 不重复刷屏，按 id 记一次）。 */
function onCloudFallback(reason: string): void {
  if (cloudFailedTabs.value.has(props.tab.id)) return;
  // Set 就地改不会触发响应式，必须换一个新的（Vue 3 的 ref 浅层比较）。
  cloudFailedTabs.value = new Set(cloudFailedTabs.value).add(props.tab.id);
  notify({
    kind: "warning",
    key: `cloud-office-fallback:${props.tab.id}`,
    title: t("preview.viewer.cloudOffice.fellBack", { name: props.tab.name }),
    detail: reason,
  });
}

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
    <component :is="activeViewer" :key="props.tab.id" :tab="props.tab" class="size-full" v-on="viewerListeners" />
    <!-- key 同 tab.id：换 tab 时重建划词层，顺带把还挂着的浮层清掉 -->
    <SelectionLayer v-if="textSelectable" :key="props.tab.id" :tab="props.tab" :root="surfaceEl" />
  </div>
</template>
