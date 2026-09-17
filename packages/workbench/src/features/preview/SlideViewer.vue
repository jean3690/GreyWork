<script setup lang="ts">
/**
 * pptx 预览：整叠幻灯片竖向滚动，每页按真实几何还原。
 *
 * **为什么不再走 Univer Slides**：Univer 0.25 的 slides 模块没有 preset（要手注册四个插件加三份
 * CSS），而它能吃下的 ISlideData 只到「一页一个富文本块」的粒度 —— 位置、字号、颜色、表格、
 * 背景在转换时就已经丢了，页面还只能一页一页翻。预览的目的恰恰是「一眼看到全部内容」，
 * 于是改成自己解析（`lib/pptx-parse.ts`）+ 用 DOM 绝对定位还原，和 PdfViewer 的页栈一致。
 *
 * **缩放靠一次 transform**：内容按幻灯片自身的 px 尺寸布局，外层只加一个 `scale()`。
 * 这样字号、间距、表格列宽都不用逐个换算，也不会因为四舍五入而错位。
 */
import { computed, onUnmounted, ref, toRef, watch } from "vue";
import { usePreviewBinary } from "@/lib/preview-content";
import { paragraphFontPt, parsePptx, type ParsedDeck, type PptxParagraph, type PptxRun } from "@/lib/pptx-parse";
import type { PreviewTab } from "@/stores/preview";

/** pt → px（CSS 参考像素：96dpi / 72pt）。 */
const PX_PER_PT = 96 / 72;
/** 幻灯片之间的留白与容器内边距（px，屏幕坐标，不参与缩放）。 */
const GUTTER = 12;
/** PowerPoint 单倍行距约等于字号的 1.2 倍。 */
const LINE_HEIGHT = 1.2;
/** 没有 latin typeface 时的兜底字族：中文材料居多，优先系统中文字体。 */
const FALLBACK_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';

const props = defineProps<{ tab: PreviewTab }>();

const { data, loading, error } = usePreviewBinary(toRef(props, "tab"));

const deck = ref<ParsedDeck | null>(null);
const parseError = ref<string | null>(null);
const scroller = ref<HTMLElement | null>(null);
/** 容器可用宽度；ResizeObserver 回灌，用于算缩放比。 */
const availableWidth = ref(0);

/** 解析代次：切 tab 时自增，让还在 await 的旧解析自我放弃，避免把上一份内容画上去。 */
let generation = 0;

watch(
  data,
  async (bytes) => {
    const mine = ++generation;
    parseError.value = null;
    if (!bytes) {
      deck.value = null;
      return;
    }
    try {
      const parsed = await parsePptx(bytes);
      if (mine !== generation) return;
      deck.value = parsed;
    } catch (cause: unknown) {
      if (mine !== generation) return;
      deck.value = null;
      parseError.value = cause instanceof Error ? cause.message : String(cause);
    }
  },
  { immediate: true },
);

let observer: ResizeObserver | null = null;
watch(scroller, (host) => {
  observer?.disconnect();
  observer = null;
  if (!host || typeof ResizeObserver === "undefined") return;
  observer = new ResizeObserver((entries) => {
    availableWidth.value = entries[0]?.contentRect.width ?? 0;
  });
  observer.observe(host);
  availableWidth.value = host.clientWidth - GUTTER * 2;
});

onUnmounted(() => {
  observer?.disconnect();
  observer = null;
});

/**
 * 缩放比：按容器宽度铺满，但不放大超过原始尺寸（放大只会让位图糊）。
 *
 * `contentRect` 已经扣掉了容器的 padding，这里不能再扣一次 GUTTER，否则每页凭空窄 24px。
 * 初值走 `clientWidth` 时要自己扣，因为 clientWidth 含 padding。
 */
const scale = computed(() => {
  const width = deck.value?.width ?? 0;
  if (width <= 0 || availableWidth.value <= 0) return 1;
  return Math.min(1, availableWidth.value / width);
});

function px(value: number): string {
  return `${value}px`;
}

/** 幻灯片外框：占位高度必须是缩放后的高度，否则页与页会重叠。 */
function frameStyle(): Record<string, string> {
  const current = deck.value;
  if (!current) return {};
  return { width: px(current.width * scale.value), height: px(current.height * scale.value) };
}

function canvasStyle(background: string | null): Record<string, string> {
  const current = deck.value;
  if (!current) return {};
  return {
    width: px(current.width),
    height: px(current.height),
    transform: `scale(${scale.value})`,
    transformOrigin: "top left",
    background: background ?? "#FFFFFF",
  };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

/** 绝对定位 + 旋转。rotate 放在 element 自身，不影响外层的整体 scale。 */
function boxStyle(rect: Rect): Record<string, string> {
  const style: Record<string, string> = {
    position: "absolute",
    left: px(rect.x),
    top: px(rect.y),
    width: px(rect.w),
    height: px(rect.h),
  };
  if (rect.rotation) style.transform = `rotate(${rect.rotation}deg)`;
  return style;
}

const ANCHOR_TO_JUSTIFY: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end" };

function textBoxStyle(rect: Rect, anchor: string, fill: string | null, line: string | null): Record<string, string> {
  return {
    ...boxStyle(rect),
    display: "flex",
    flexDirection: "column",
    justifyContent: ANCHOR_TO_JUSTIFY[anchor] ?? "flex-start",
    // 不裁剪溢出：文本框算出来比内容小是常态，裁掉就又「看不到完整内容」了
    overflow: "visible",
    ...(fill ? { background: fill } : {}),
    ...(line ? { border: `1px solid ${line}` } : {}),
  };
}

function shapeStyle(rect: Rect, fill: string | null, line: string | null, geometry: string): Record<string, string> {
  const radius = geometry === "ellipse" ? "50%" : geometry === "round" ? "8px" : undefined;
  return {
    ...boxStyle(rect),
    ...(fill ? { background: fill } : {}),
    ...(line ? { border: `1px solid ${line}` } : {}),
    ...(radius ? { borderRadius: radius } : {}),
  };
}

function paragraphStyle(paragraph: PptxParagraph): Record<string, string> {
  const fontPt = paragraphFontPt(paragraph);
  return {
    margin: "0",
    fontSize: px(fontPt * PX_PER_PT),
    lineHeight: String(LINE_HEIGHT),
    textAlign: paragraph.align ?? "start",
    // 段内 <a:br> 变成了 "\n"，靠 pre-wrap 生效；同时保留连续空格
    whiteSpace: "pre-wrap",
    ...(paragraph.indent > 0 ? { paddingInlineStart: px(paragraph.indent) } : {}),
    ...(paragraph.bullet ? { textIndent: px(-Math.min(paragraph.indent, 18)) } : {}),
  };
}

function runStyle(run: PptxRun): Record<string, string> {
  return {
    fontFamily: run.font ? `"${run.font}", ${FALLBACK_FONT}` : FALLBACK_FONT,
    ...(run.sizePt ? { fontSize: px(run.sizePt * PX_PER_PT) } : {}),
    ...(run.bold ? { fontWeight: "700" } : {}),
    ...(run.italic ? { fontStyle: "italic" } : {}),
    ...(run.underline ? { textDecoration: "underline" } : {}),
    ...(run.color ? { color: run.color } : {}),
  };
}

function cellStyle(fill: string | null): Record<string, string> {
  return {
    padding: "4px 6px",
    verticalAlign: "middle",
    border: "1px solid rgba(0, 0, 0, 0.12)",
    ...(fill ? { background: fill } : {}),
  };
}

const slideCount = computed(() => deck.value?.slides.length ?? 0);
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span>{{ slideCount > 0 ? `共 ${slideCount} 页` : "演示文稿" }}</span>
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-orange">读取失败：{{ error }}</p>
    <p v-else-if="parseError" role="alert" class="px-4 py-3 text-[12px] text-orange">
      无法解析该演示文稿：{{ parseError }}。可点上方工具栏的「用系统应用打开」看原文件。
    </p>
    <p v-else-if="deck && slideCount === 0" class="px-4 py-3 text-[12px] text-dim2">这份演示文稿没有幻灯片。</p>

    <div
      v-show="!loading && !error && !parseError"
      ref="scroller"
      data-testid="slide-viewer"
      data-selection-scope
      data-scroll-root
      class="min-h-0 flex-1 overflow-y-auto bg-background"
      :style="{ padding: `${GUTTER}px` }"
    >
      <template v-if="deck">
        <section v-for="slide in deck.slides" :key="slide.index" class="mb-4 last:mb-0">
          <!-- 外框只负责占位（缩放后的尺寸）与边框；内容在里面按原始 px 布局 -->
          <div data-testid="slide-page" class="overflow-hidden rounded-[6px] border border-line-2 shadow-sm" :style="frameStyle()">
            <div :style="canvasStyle(slide.background)" class="relative">
              <template v-for="(element, index) in slide.elements" :key="index">
                <div v-if="element.kind === 'shape'" :style="shapeStyle(element.rect, element.fill, element.line, element.geometry)" />

                <img v-else-if="element.kind === 'image'" :src="element.src" :alt="element.alt" :style="boxStyle(element.rect)" />

                <div
                  v-else-if="element.kind === 'text'"
                  data-testid="slide-text"
                  :style="textBoxStyle(element.rect, element.anchor, element.fill, element.line)"
                >
                  <p v-for="(paragraph, pIndex) in element.paragraphs" :key="pIndex" :style="paragraphStyle(paragraph)">
                    <!-- 间距用 margin，不靠插值里的空格：Vue 会把文本节点尾部空白吃掉 -->
                    <span v-if="paragraph.bullet" aria-hidden="true" class="me-[0.4em]">{{ paragraph.bullet }}</span>
                    <span v-for="(run, rIndex) in paragraph.runs" :key="rIndex" :style="runStyle(run)">{{ run.text }}</span>
                  </p>
                </div>

                <table
                  v-else
                  data-testid="slide-table"
                  :style="{ ...boxStyle(element.rect), borderCollapse: 'collapse', tableLayout: 'fixed', height: 'auto' }"
                >
                  <colgroup>
                    <col v-for="(width, cIndex) in element.colWidths" :key="cIndex" :style="{ width: `${width}px` }" />
                  </colgroup>
                  <tbody>
                    <tr v-for="(row, rowIndex) in element.rows" :key="rowIndex">
                      <template v-for="(cell, cellIndex) in row.cells" :key="cellIndex">
                        <td
                          v-if="!cell.covered"
                          :colspan="cell.colSpan > 1 ? cell.colSpan : undefined"
                          :rowspan="cell.rowSpan > 1 ? cell.rowSpan : undefined"
                          :style="cellStyle(cell.fill)"
                        >
                          <p v-for="(paragraph, pIndex) in cell.paragraphs" :key="pIndex" :style="paragraphStyle(paragraph)">
                            <span v-for="(run, rIndex) in paragraph.runs" :key="rIndex" :style="runStyle(run)">{{ run.text }}</span>
                          </p>
                        </td>
                      </template>
                    </tr>
                  </tbody>
                </table>
              </template>
            </div>
          </div>

          <div class="mt-1 flex items-baseline gap-2 px-0.5">
            <span class="shrink-0 text-[10.5px] text-dim2">第 {{ slide.index }} 页</span>
            <!-- 备注是 pptx 里真实存在的内容，藏起来同样算「看不到完整内容」 -->
            <span v-if="slide.notes" class="min-w-0 flex-1 whitespace-pre-wrap text-[10.5px] text-dim2"> 备注：{{ slide.notes }} </span>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
