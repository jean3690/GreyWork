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
import { onUnmounted, ref, toRef, watch } from "vue";
// 只取 URL 字符串，Vite 会把 worker 作为资源单独产出（v6 是 ESM worker）。
// 用预压缩的 *.min.mjs：worker 是 ?url 原样拷贝的资产，不走 Vite minify，
// 非 min 版 2.2MB 会原封不动躺进安装包。
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { usePreviewBinary } from "../../lib/preview-content";
import type { PreviewTab } from "../../stores/preview";

/** 首批渲染页数；其余滚到底部再追加 —— 200 页的 PDF 一次性渲染会卡死主线程。 */
const PAGE_BATCH = 3;
/** 距底部多少 px 触发追加。 */
const LOAD_AHEAD_PX = 400;

interface PdfViewport {
  width: number;
  height: number;
}
interface PdfRenderTask {
  promise: Promise<void>;
  cancel: () => void;
}
interface PdfPage {
  getViewport: (options: { scale: number }) => PdfViewport;
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => PdfRenderTask;
}
interface PdfDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  destroy: () => Promise<void>;
}

const props = defineProps<{ tab: PreviewTab }>();

const { data, loading, error } = usePreviewBinary(toRef(props, "tab"));

const scroller = ref<HTMLElement | null>(null);
const pagesHost = ref<HTMLElement | null>(null);
const totalPages = ref(0);
const renderedPages = ref(0);
const renderError = ref<string | null>(null);

let doc: PdfDocument | null = null;
let activeTasks: PdfRenderTask[] = [];
/** 渲染代次：内容切换时自增，旧的异步渲染据此自我放弃。 */
let generation = 0;

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

async function renderNextBatch(mine: number): Promise<void> {
  const document_ = doc;
  const host = pagesHost.value;
  if (!document_ || !host) return;
  // 高分屏下不乘 devicePixelRatio 会明显发糊：位图按 dpr 放大，CSS 尺寸保持逻辑值。
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  const from = renderedPages.value + 1;
  const to = Math.min(document_.numPages, renderedPages.value + PAGE_BATCH);
  for (let pageNumber = from; pageNumber <= to; pageNumber += 1) {
    const page = await document_.getPage(pageNumber);
    if (mine !== generation) return;
    const viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    canvas.className = "mx-auto mb-3 block max-w-full shadow";
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法获取 canvas 2d 上下文");
    const task = page.render({ canvasContext: context, viewport: page.getViewport({ scale: dpr }) });
    activeTasks.push(task);
    await task.promise;
    activeTasks = activeTasks.filter((candidate) => candidate !== task);
    if (mine !== generation) return;
    host.appendChild(canvas);
    renderedPages.value = pageNumber;
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
    const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
    const opened = (await loadingTask.promise) as unknown as PdfDocument;
    if (mine !== generation) {
      await opened.destroy().catch(() => undefined);
      return;
    }
    doc = opened;
    totalPages.value = opened.numPages;
    await renderNextBatch(mine);
  } catch (cause: unknown) {
    if (mine !== generation) return;
    renderError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function onScroll(): void {
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

onUnmounted(() => {
  generation += 1;
  void teardown();
});
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span>{{ totalPages > 0 ? `已渲染 ${renderedPages} / 共 ${totalPages} 页` : "PDF" }}</span>
    </div>
    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-red-400">读取失败：{{ error }}</p>
    <p v-else-if="renderError" role="alert" class="px-4 py-3 text-[12px] text-red-400">
      无法渲染该 PDF：{{ renderError }}。可在文件夹中打开原文件。
    </p>
    <div
      v-show="!loading && !error && !renderError"
      ref="scroller"
      data-testid="pdf-viewer"
      class="min-h-0 flex-1 overflow-y-auto bg-background p-3"
      @scroll.passive="onScroll"
    >
      <div ref="pagesHost" />
    </div>
  </div>
</template>
