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
 *
 * **可就地编辑文本**：a:r 文本 run 是 contenteditable，改字经 `patchPptxText` 只补对应 slideN.xml
 * 里的 a:t、其余字节原样保留（不改版式 / 母版 / 媒体）。脏标记、保存、关闭前确认由外壳统一提供。
 */
import { computed, onUnmounted, ref, toRef, watch } from "vue";
import { usePreviewBinary } from "@/lib/preview-content";
import { paragraphFontPt, parsePptx, type ParsedDeck, type PptxParagraph, type PptxRun, type PptxTextRef } from "@/lib/pptx-parse";
import { patchPptxText } from "@/lib/pptx-serialize";
import { registerPreviewSaver, unregisterPreviewSaver, writePreviewBytes } from "@/lib/preview-save";
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

/** 编辑缓冲：`${slide}:${ord}` → 新文本；保存时对基线字节做就地补丁。 */
const edits = new Map<string, string>();
/** 有未保存改动。外壳据此显示脏点 / 启用保存。 */
const dirty = ref(false);
/** 回写基线：初次为读入字节，保存后替换为刚写出的字节（a:t 编号不变，可继续编辑）。 */
let baseline: Uint8Array | null = null;

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
      baseline = null;
      edits.clear();
      dirty.value = false;
      return;
    }
    try {
      const parsed = await parsePptx(bytes);
      if (mine !== generation) return;
      deck.value = parsed;
      // 载入新内容即重置编辑态：基线换成这份字节，旧编辑作废。
      baseline = bytes;
      edits.clear();
      dirty.value = false;
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
  unregisterPreviewSaver(props.tab.id);
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

/** 深底给浅字、浅底给深字：pptx 的文字颜色常留空由主题继承（尤其生成类演示），
 *  照搬就会黑字压深底 —— 内容在 DOM 里却看不见。深色标题/章节页极常见，是最影响观感的保真缺口。
 *  只作为兜底：run 自己声明了颜色（runStyle 里的 color）会覆盖，绝不篡改文档写明的颜色。
 *  DocxBlocks 早已对表格单元格做了同款处理，这里补齐 pptx 侧。 */
const DARK_INK = "#1A1A1A";
const LIGHT_INK = "#FAFAF9";

/** 相对亮度低于 0.5 视为深色（ITU-R BT.601 感知权重）。非 #rrggbb 一律当浅色。 */
function isDark(color: string): boolean {
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return false;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/** 文字兜底色：取最近的不透明底色（文本框/单元格填充，否则幻灯片背景，否则白）判明暗。
 *  幻灯片画布背景本就明确写出，据此推断比继承应用主题色更可靠（暗色应用主题下白底会得到浅字）。 */
function inkFor(background: string | null): string {
  return background && isDark(background) ? LIGHT_INK : DARK_INK;
}

function textBoxStyle(
  rect: Rect,
  anchor: string,
  fill: string | null,
  line: string | null,
  slideBackground: string | null,
): Record<string, string> {
  return {
    ...boxStyle(rect),
    display: "flex",
    flexDirection: "column",
    justifyContent: ANCHOR_TO_JUSTIFY[anchor] ?? "flex-start",
    // 不裁剪溢出：文本框算出来比内容小是常态，裁掉就又「看不到完整内容」了
    overflow: "visible",
    color: inkFor(fill ?? slideBackground),
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

function cellStyle(fill: string | null, slideBackground: string | null): Record<string, string> {
  return {
    padding: "4px 6px",
    verticalAlign: "middle",
    border: "1px solid rgba(0, 0, 0, 0.12)",
    color: inkFor(fill ?? slideBackground),
    ...(fill ? { background: fill } : {}),
  };
}

const slideCount = computed(() => deck.value?.slides.length ?? 0);

/** 某个 run 改字：按 `${slide}:${ord}` 记进缓冲并标脏。 */
function onRunInput(event: Event, ref: PptxTextRef | null | undefined): void {
  if (!ref) return;
  edits.set(`${ref.slide}:${ref.ord}`, (event.target as HTMLElement).textContent ?? "");
  dirty.value = true;
}

/** 只允许纯文本编辑：拦掉富文本粘贴，保结构只改字。 */
function onPlainPaste(event: ClipboardEvent): void {
  event.preventDefault();
  document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? "");
}

/** 保存：对基线字节就地补丁后回写来源；随后以新字节为基线重解析（a:t 编号不变）。 */
async function save(): Promise<void> {
  if (!baseline || edits.size === 0) return;
  const bytes = await patchPptxText(baseline, edits);
  await writePreviewBytes(props.tab, bytes);
  baseline = bytes;
  deck.value = await parsePptx(bytes);
  edits.clear();
  dirty.value = false;
}

registerPreviewSaver(props.tab.id, { dirty, save });
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
                  :style="textBoxStyle(element.rect, element.anchor, element.fill, element.line, slide.background)"
                >
                  <p v-for="(paragraph, pIndex) in element.paragraphs" :key="pIndex" :style="paragraphStyle(paragraph)">
                    <!-- 间距用 margin，不靠插值里的空格：Vue 会把文本节点尾部空白吃掉 -->
                    <span v-if="paragraph.bullet" aria-hidden="true" class="me-[0.4em]">{{ paragraph.bullet }}</span>
                    <template v-for="(run, rIndex) in paragraph.runs" :key="rIndex">
                      <span
                        v-if="run.editId != null"
                        data-testid="slide-editable"
                        contenteditable="true"
                        class="outline-none focus:bg-cyan/20"
                        :style="runStyle(run)"
                        @input="onRunInput($event, run.editId)"
                        @keydown.enter.prevent
                        @paste="onPlainPaste"
                        >{{ run.text }}</span
                      >
                      <span v-else :style="runStyle(run)">{{ run.text }}</span>
                    </template>
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
                          :style="cellStyle(cell.fill, slide.background)"
                        >
                          <p v-for="(paragraph, pIndex) in cell.paragraphs" :key="pIndex" :style="paragraphStyle(paragraph)">
                            <template v-for="(run, rIndex) in paragraph.runs" :key="rIndex">
                              <span
                                v-if="run.editId != null"
                                data-testid="slide-editable"
                                contenteditable="true"
                                class="outline-none focus:bg-cyan/20"
                                :style="runStyle(run)"
                                @input="onRunInput($event, run.editId)"
                                @keydown.enter.prevent
                                @paste="onPlainPaste"
                                >{{ run.text }}</span
                              >
                              <span v-else :style="runStyle(run)">{{ run.text }}</span>
                            </template>
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
