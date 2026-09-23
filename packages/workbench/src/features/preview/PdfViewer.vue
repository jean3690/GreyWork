<script setup lang="ts">
/**
 * PDF 预览：pdf.js 逐页画到 canvas。
 *
 * **为什么必须自己渲染**：Tauri 在 Linux 走 WebKitGTK，它不带内置 PDF viewer —— 把 PDF
 * 塞进 `<iframe>` / `<embed>` 在 Linux 上是空白或直接触发下载。Windows 的 WebView2 与
 * macOS 的 WKWebView 都自带查看器，所以这个坑只在 Linux 显形，而本项目就在 Linux 上开发。
 * 与其写一段「三个平台三种行为」的分支，不如统一走 pdf.js，观感也一致。
 *
 * **workerSrc 是唯一容易踩的一步**：不显式指定，打包后 pdf.js 会去猜 worker 路径，
 * 结果是 404 或退化成 "Setting up fake worker failed"。用 Vite 的 `?url` 让 worker
 * 作为独立资源产出，再把地址交给 pdf.js。
 */
import { computed, onBeforeUnmount, onUnmounted, ref, toRef, watch } from "vue";
import { useI18n } from "vue-i18n";
// 只取 URL 字符串，Vite 会把 worker 作为资源单独产出（v6 是 ESM worker）。
// 用预压缩的 *.min.mjs：worker 是 ?url 原样拷贝的资产，不走 Vite minify，
// 非 min 版 2.2MB 会原封不动躺进安装包。
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { buildTextLayer, layoutTextItems, type MeasureText } from "@/lib/pdf-text-layer";
import { clampPage, clampZoom, zoomBy } from "@/lib/pdf-zoom";
import Icon from "@/features/shared/Icon.vue";
import { deviceTier } from "@/lib/device-tier";
import { recallPdfProgress, rememberPdfProgress } from "@/lib/preview-scroll";
import { usePreviewBinary } from "@/lib/preview-content";
import PreviewExternalButton from "@/features/preview/PreviewExternalButton.vue";
import type { PreviewTab } from "@/stores/preview";

/**
 * 首批渲染页数；其余滚到底部再追加 —— 200 页的 PDF 一次性渲染会卡死主线程。
 *
 * 低端设备（lib/device-tier.ts）收到 1 页：每页画布按 dpr 放大后的位图是实打实的显存/
 * 内存占用，低内存机上"一次三页"很容易顶到峰值。代价是滚动到底部的追加更频繁，
 * 但每次只画一页，主线程不会被长任务占住。
 */
const PAGE_BATCH = computed(() => (deviceTier.value === "low" ? 1 : 3));
/** 距底部多少 px 触发追加。 */
const LOAD_AHEAD_PX = 400;
/**
 * 量宽用的回退字体。
 *
 * 我们**不加载 PDF 的内嵌字体**（那要把 FontLoader 与字体资源一起搬进来），所以量宽只能
 * 用回退字体，`scaleX` 是近似值：它保证每个 span 的总宽度正确（消除逐段累积的横向偏移），
 * 但不保证 span 内部的每个字形都与 canvas 上的墨迹严格对齐。
 */
const MEASURE_FONT = "sans-serif";

interface PdfViewport {
  width: number;
  height: number;
  /** 文本空间 → 视口坐标的矩阵，文本层要靠它换算每个文字项的位置。 */
  transform: number[];
}
interface PdfRenderTask {
  promise: Promise<void>;
  cancel: () => void;
}
interface PdfPage {
  getViewport: (options: { scale: number }) => PdfViewport;
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => PdfRenderTask;
  getTextContent: () => Promise<{ items: unknown[] }>;
}
interface PdfDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  destroy: () => Promise<void>;
}

const props = defineProps<{ tab: PreviewTab }>();

const { t } = useI18n();

const { data, loading, error } = usePreviewBinary(toRef(props, "tab"));

const scroller = ref<HTMLElement | null>(null);
const pagesHost = ref<HTMLElement | null>(null);
const totalPages = ref(0);
const renderedPages = ref(0);
const renderError = ref<string | null>(null);
/** 缩放倍率：1 = 适应宽度（基准）。见 lib/pdf-zoom.ts。 */
const zoom = ref(1);
/** 当前视口顶部的页码（工具栏显示 + 上一页/下一页的基准）。 */
const currentPage = ref(1);

let doc: PdfDocument | null = null;
let activeTasks: PdfRenderTask[] = [];
/** 渲染代次：内容切换时自增，旧的异步渲染据此自我放弃。 */
let generation = 0;
/** 本次挂载是否已还原过阅读位置 —— 只还原一次；同 tab 的内容更新（revision 变化）不重复还原。 */
let restored = false;

/** 量宽用的共享上下文；拿不到（无 2d 上下文）就退化为不拉伸。 */
const measureCanvas = document.createElement("canvas");
const measureContext = measureCanvas.getContext("2d");
const measureText: MeasureText = (text, fontSize) => {
  if (!measureContext) return 0;
  measureContext.font = `${fontSize}px ${MEASURE_FONT}`;
  return measureContext.measureText(text).width;
};

/**
 * 本页的渲染缩放：按可用宽度自适应，**且只缩不放**。
 *
 * 这一步是文本层能对齐的前提。以前是「按 scale 1 渲染 + CSS 的 max-w-full 压缩」，
 * canvas 会被 CSS 压窄而文本层的绝对定位不会 —— 窄面板下选中位置整体偏移。
 * 改成先把缩放算出来，canvas 与文本层共用同一个 viewport，两边坐标系天然一致，
 * 也就不再需要 max-w-full 兜底（宽度已按容器算好）。
 */
function fitScaleOf(host: HTMLElement, baseWidth: number): number {
  const available = host.clientWidth;
  if (!(available > 0) || !(baseWidth > 0)) return 1;
  return Math.min(1, available / baseWidth);
}

async function teardown(): Promise<void> {
  for (const task of activeTasks) task.cancel();
  activeTasks = [];
  const current = doc;
  doc = null;
  totalPages.value = 0;
  renderedPages.value = 0;
  if (pagesHost.value) pagesHost.value.replaceChildren();
  // destroy 会关掉 worker；不调它就每开一次 PDF 漏一个 worker 进程。
  await current?.destroy().catch(() => undefined);
}

/**
 * 给一页铺文本层（让 PDF 可以划词与复制）。
 *
 * canvas 画的是墨迹，文字层是一堆 `color: transparent` 的 span 叠在上面 ——
 * 选中时看到的是 span 的选区背景，字形仍来自 canvas。
 */
async function appendTextLayer(
  page: PdfPage,
  pageNumber: number,
  viewport: PdfViewport,
  wrapper: HTMLElement,
  mine: number,
): Promise<void> {
  const content = await page.getTextContent();
  if (mine !== generation) return;
  if (!wrapper.isConnected) return;

  const layer = document.createElement("div");
  layer.className = "pdf-text-layer";
  const pieces = layoutTextItems(content.items as { str?: string; width?: number; transform?: number[] }[], viewport.transform);
  buildTextLayer(layer, pieces, measureText);
  layer.dataset.selectionRole = "block";
  // 页码是 PDF 里最有用的一处定位信息 —— 长文档里「哪一段」几乎等价于「哪一页」。
  layer.dataset.selectionLocation = t("preview.selection.pageLocation", { n: pageNumber });
  wrapper.appendChild(layer);
}

async function renderNextBatch(mine: number): Promise<void> {
  const document_ = doc;
  const host = pagesHost.value;
  if (!document_ || !host) return;
  // 高分屏下不乘 devicePixelRatio 会明显发糊：位图按 dpr 放大，CSS 尺寸保持逻辑值。
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  const from = renderedPages.value + 1;
  const to = Math.min(document_.numPages, renderedPages.value + PAGE_BATCH.value);
  for (let pageNumber = from; pageNumber <= to; pageNumber += 1) {
    const page = await document_.getPage(pageNumber);
    if (mine !== generation) return;
    const base = page.getViewport({ scale: 1 });
    // 渲染缩放 = 「按容器宽度的基准」× 用户缩放。
    // 缩放落在渲染阶段而不是给容器套 CSS transform：canvas 的 CSS 宽高跟着变，布局高度
    // 才是真实高度 —— transform 不改变布局，放大后滚动区不会变长，底部内容根本滚不到。
    const scale = fitScaleOf(host, base.width) * zoom.value;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.className = "block shadow";
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("preview.viewer.pdf.canvasFailed"));
    const task = page.render({ canvasContext: context, viewport: page.getViewport({ scale: scale * dpr }) });
    activeTasks.push(task);
    await task.promise;
    activeTasks = activeTasks.filter((candidate) => candidate !== task);
    if (mine !== generation) return;

    // 包裹层让 canvas 与文本层共用同一个坐标系：文本层用 inset 绝对定位铺满整页。
    const wrapper = document.createElement("div");
    wrapper.className = "relative mx-auto mb-3 w-fit";
    wrapper.appendChild(canvas);
    host.appendChild(wrapper);
    renderedPages.value = pageNumber;

    // 文本层失败不该让整页预览崩掉：画布已经出来了，没有可选的文字总比白屏好。
    await appendTextLayer(page, pageNumber, viewport, wrapper, mine).catch(() => undefined);
  }
}

/** 视口顶部的页码：已渲染页里最后一个顶部不超过容器的那个。 */
function updateCurrentPage(): void {
  const host = pagesHost.value;
  const element = scroller.value;
  if (!host || !element || totalPages.value === 0) return;
  const top = element.getBoundingClientRect().top;
  let page = 1;
  for (let index = 0; index < host.children.length; index += 1) {
    const child = host.children[index] as HTMLElement;
    if (child.getBoundingClientRect().top - top <= 8) page = index + 1;
    else break;
  }
  currentPage.value = clampPage(page, totalPages.value);
}

/** 补渲染到目标页（复用追加渲染的循环），再滚到那一页。 */
async function goToPage(target: number): Promise<void> {
  const page = clampPage(target, totalPages.value);
  const mine = generation;
  while (renderedPages.value < page && renderedPages.value < totalPages.value) {
    const before = renderedPages.value;
    await renderNextBatch(mine);
    if (mine !== generation) return; // 内容已换，这轮作废
    if (renderedPages.value === before) break;
  }
  const child = pagesHost.value?.children[page - 1] as HTMLElement | undefined;
  child?.scrollIntoView({ block: "start" });
  currentPage.value = page;
}

/**
 * 缩放变化后按新倍率重渲染已渲染过的那几页，并回到同一页。
 *
 * 只重画、不重解析：`renderNextBatch` 从第 1 页开始填，填完按页号还原阅读位置。
 */
async function rerenderAtZoom(): Promise<void> {
  if (!doc) return;
  const mine = generation;
  const keep = renderedPages.value;
  // 在跑的任务按新倍率作废：它们的 viewport 是旧缩放算出来的。
  for (const task of activeTasks) task.cancel();
  activeTasks = [];
  renderedPages.value = 0;
  pagesHost.value?.replaceChildren();
  while (renderedPages.value < keep && renderedPages.value < totalPages.value) {
    const before = renderedPages.value;
    await renderNextBatch(mine);
    if (mine !== generation) return;
    if (renderedPages.value === before) break;
  }
  await goToPage(keep || 1);
}

/** 缩放入口：改倍率 → 重渲染 → 回到同一页。 */
function applyZoom(next: number): void {
  const value = clampZoom(next);
  if (value === zoom.value) return;
  zoom.value = value;
  void rerenderAtZoom();
}

/** 页码输入框（change / Enter 才提交，不做 v-model：每敲一位都补渲染太吵）。 */
function onPageInput(event: Event): void {
  const target = event.target as HTMLInputElement | null;
  if (target) void goToPage(Number(target.value));
}

const toolButtonClass =
  "grid size-5 shrink-0 cursor-pointer place-items-center rounded-[5px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-dim2";

/**
 * 还原上次的阅读位置。
 *
 * PDF 是本仓唯一「内容渐进存在」的渲染器：只存像素偏移没有意义 —— 内容补齐之前那个位置
 * 根本滚不到（滚不到就会被浏览器按当前内容高度收敛掉）。所以存的是「已渲染页数 + 偏移」，
 * 回来先把页数补渲染出来，再套偏移。这条路径刻意不走 `data-scroll-root`（那是给一次性
 * 渲染出全部内容的 DOM 类 viewer 用的，见 lib/preview-scroll.ts）。
 */
async function restoreProgress(mine: number): Promise<void> {
  const progress = recallPdfProgress(props.tab.id);
  if (!progress) return;
  // 上次就停在顶部（滚下去又滚回来）：位置本来就是对的，不必为了还它去补渲染。
  if (progress.top === 0) return;

  // 补渲染到上次的页数。renderNextBatch 一批只画 PAGE_BATCH 页，所以要循环；
  // 页数不再增长（到末尾或渲染失败）就停，避免空转。
  while (renderedPages.value < progress.pages && renderedPages.value < totalPages.value) {
    const before = renderedPages.value;
    await renderNextBatch(mine);
    if (mine !== generation) return; // 内容已换，这轮作废
    if (renderedPages.value === before) break;
  }
  if (mine !== generation) return;

  // 容器此刻未必可滚（异步组件 + 布局未落定），轮询到「真能滚」再写 scrollTop，有界放弃。
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (mine !== generation) return;
    const element = scroller.value;
    if (element && element.scrollHeight > element.clientHeight) {
      element.scrollTop = progress.top;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function load(bytes: Uint8Array): Promise<void> {
  await teardown();
  const mine = ++generation;
  renderError.value = null;
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    // pdf.js 会接管并转移这块 buffer，传副本以免 vfs 缓存里的数据被清空。
    //
    // 这几行资源 URL 不是可选项：缺 CMap 时 CJK 文本用内置编码回退，断字错误或整页缺字；
    // 缺 standard_fonts 时未嵌入字体的页面是空白。两种情况 pdf.js 都**静默降级**、不抛错，
    // 所以只能靠这里配对（资源由 vite-plugin-static-copy 从 pdfjs-dist 复制到 /pdfjs/，
    // 见 apps/desktop/vite.config.ts）。路径以 / 开头走 WebView 自身，不受 CSP 的 connect-src 影响。
    const loadingTask = pdfjs.getDocument({
      data: bytes.slice(),
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      iccUrl: "/pdfjs/iccs/",
    });
    const opened = (await loadingTask.promise) as unknown as PdfDocument;
    if (mine !== generation) {
      await opened.destroy().catch(() => undefined);
      return;
    }
    doc = opened;
    totalPages.value = opened.numPages;
    await renderNextBatch(mine);
    // 只在首次挂载还原：同 tab 的内容更新（revision 变化）不该把用户拽回旧位置。
    // 还原失败不该影响预览本身 —— 顶多回到顶部。
    if (!restored) {
      restored = true;
      await restoreProgress(mine).catch(() => undefined);
    }
    updateCurrentPage();
  } catch (cause: unknown) {
    if (mine !== generation) return;
    renderError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function onScroll(): void {
  updateCurrentPage();
  const element = scroller.value;
  if (!element || !doc) return;
  if (renderedPages.value >= totalPages.value) return;
  if (element.scrollHeight - element.scrollTop - element.clientHeight > LOAD_AHEAD_PX) return;
  void renderNextBatch(generation);
}

watch(
  data,
  (bytes) => {
    if (!bytes) {
      void teardown();
      return;
    }
    void load(bytes);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  // 保存要在 teardown 之前：teardown 会把 renderedPages 归零、清空容器。
  // 一页都没渲染出来时不记（没有还原意义）。
  const element = scroller.value;
  if (element && renderedPages.value > 0) {
    // 像素偏移随缩放线性变化，换算回「适应宽度」下的等价位置 —— 还原一律从基准缩放
    // 开始，存放大态下的原始 scrollTop 会对不上。
    rememberPdfProgress(props.tab.id, { pages: renderedPages.value, top: element.scrollTop / zoom.value });
  }
});

onUnmounted(() => {
  generation += 1;
  void teardown();
});
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">
        {{ totalPages > 0 ? t("preview.pdf.rendered", { done: renderedPages, total: totalPages }) : "PDF" }}
      </span>

      <!-- 跳页 -->
      <button
        type="button"
        data-testid="pdf-prev"
        :class="toolButtonClass"
        :aria-label="t('preview.pdf.prev')"
        :disabled="currentPage <= 1"
        @click="goToPage(currentPage - 1)"
      >
        <Icon name="left" :size="11" />
      </button>
      <input
        data-testid="pdf-page-input"
        type="number"
        min="1"
        :value="currentPage"
        :aria-label="t('preview.pdf.pageLabel')"
        class="h-5 w-10 shrink-0 rounded-[5px] border border-line-2 bg-panel px-1 text-center text-[11px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        @change="onPageInput"
        @keydown.enter="onPageInput"
      />
      <span class="shrink-0 tabular-nums">/ {{ totalPages || "–" }}</span>
      <button
        type="button"
        data-testid="pdf-next"
        :class="toolButtonClass"
        :aria-label="t('preview.pdf.next')"
        :disabled="totalPages > 0 && currentPage >= totalPages"
        @click="goToPage(currentPage + 1)"
      >
        <Icon name="right" :size="11" />
      </button>

      <!-- 缩放：1 倍 = 适应宽度 -->
      <button
        type="button"
        data-testid="pdf-zoom-out"
        :class="toolButtonClass"
        :aria-label="t('preview.pdf.zoomOut')"
        @click="applyZoom(zoomBy(zoom, -1))"
      >
        <Icon name="minus" :size="11" />
      </button>
      <span class="w-9 shrink-0 text-center tabular-nums" data-testid="pdf-zoom-level">{{ Math.round(zoom * 100) }}%</span>
      <button
        type="button"
        data-testid="pdf-zoom-in"
        :class="toolButtonClass"
        :aria-label="t('preview.pdf.zoomIn')"
        @click="applyZoom(zoomBy(zoom, 1))"
      >
        <Icon name="plus" :size="11" />
      </button>
      <button
        type="button"
        data-testid="pdf-fit"
        class="h-5 shrink-0 cursor-pointer rounded-[5px] px-1.5 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        :class="zoom === 1 ? 'bg-panel text-foreground' : 'text-dim2 hover:bg-panel hover:text-foreground'"
        :aria-label="t('preview.pdf.fitWidth')"
        :aria-pressed="zoom === 1"
        @click="applyZoom(1)"
      >
        {{ t("preview.pdf.fitWidth") }}
      </button>
    </div>
    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.common.loading") }}</p>
    <div v-else-if="error" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-orange">{{ t("preview.common.readFailed", { detail: error }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div v-else-if="renderError" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-orange">{{ t("preview.pdf.renderFailed", { detail: renderError }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div
      v-show="!loading && !error && !renderError"
      ref="scroller"
      data-testid="pdf-viewer"
      class="min-h-0 flex-1 overflow-y-auto bg-background p-3"
      @scroll.passive="onScroll"
    >
      <!-- 划词作用域打在页面容器上：文本层的 span 动态创建，靠 lib/selection.ts 的
           data-selection-* 契约向上回溯语义，所以这里只需要一个正文根 -->
      <div ref="pagesHost" data-selection-scope />
    </div>
  </div>
</template>

<!--
  必须是非 scoped 的全局样式：文本层的 span 是运行时 createElement 出来的，
  拿不到 SFC 编译期加的 scope 属性，scoped 规则一条都命中不了。

  `color: transparent` 是这套做法的关键 —— 字形由下面的 canvas 提供，span 只负责
  承载选区。因此选中时看到的是 ::selection 的背景色，而不是文字本身。
-->
<style>
.pdf-text-layer {
  position: absolute;
  inset: 0;
  overflow: clip;
  line-height: 1;
  letter-spacing: normal;
  word-spacing: normal;
  text-size-adjust: none;
  -webkit-text-size-adjust: none;
  transform-origin: 0 0;
  /* 压在 canvas 之上才能接收指针事件；canvas 本身不需要交互 */
  z-index: 1;
}

.pdf-text-layer span {
  position: absolute;
  white-space: pre;
  cursor: text;
  color: transparent;
  transform-origin: 0 0;
}

.pdf-text-layer ::selection {
  background: rgb(56 189 248 / 0.35);
}
</style>
