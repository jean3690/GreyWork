<script setup lang="ts">
/**
 * docx 块级渲染（段落 / 表格），自引用以支持单元格内嵌套块。
 *
 * 递归组件在这里是划算的：嵌套深度由文档结构决定（表格套表格最多两三层），
 * 不像文件树那种可能几十层的场景。换成展平反而要自己维护一套单元格边界。
 */
import { HEADING_SCALE, runFontPt, type DocxBlock, type DocxParagraph, type DocxRun } from "../../lib/docx-parse";

/** pt → px（CSS 参考像素：96dpi / 72pt）。 */
const PX_PER_PT = 96 / 72;
/** Word 正文默认行距约 1.15，标题略紧。 */
const LINE_HEIGHT = 1.5;
const FALLBACK_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';

defineProps<{ blocks: DocxBlock[] }>();

function px(value: number): string {
  return `${value}px`;
}

/**
 * 只放行 http/https/mailto。
 *
 * 链接目标来自文档内容，而文档可能是 AI 生成或用户从别处拿来的：
 * `javascript:` 一旦进 href 就是一次点击即执行的 XSS。
 */
function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url, "https://invalid.local");
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

function paragraphStyle(paragraph: DocxParagraph): Record<string, string> {
  const scale = paragraph.heading ? (HEADING_SCALE[paragraph.heading] ?? 1) : 1;
  return {
    margin: "0",
    marginTop: px(paragraph.spaceBefore),
    marginBottom: px(paragraph.spaceAfter || (paragraph.heading ? 8 : 6)),
    ...(paragraph.indent > 0 ? { paddingInlineStart: px(paragraph.indent) } : {}),
    textAlign: paragraph.align ?? "start",
    lineHeight: String(paragraph.heading ? 1.3 : LINE_HEIGHT),
    // 段内 <w:br/> 变成了 "\n"，靠 pre-wrap 生效；制表符同理
    whiteSpace: "pre-wrap",
    ...(paragraph.heading ? { fontWeight: "600", fontSize: `${scale}em` } : {}),
  };
}

function runStyle(run: DocxRun): Record<string, string> {
  return {
    fontFamily: run.font ? `"${run.font}", ${FALLBACK_FONT}` : FALLBACK_FONT,
    ...(run.sizePt ? { fontSize: px(runFontPt(run) * PX_PER_PT) } : {}),
    ...(run.bold ? { fontWeight: "700" } : {}),
    ...(run.italic ? { fontStyle: "italic" } : {}),
    ...(run.underline && run.strike
      ? { textDecoration: "underline line-through" }
      : run.underline
        ? { textDecoration: "underline" }
        : run.strike
          ? { textDecoration: "line-through" }
          : {}),
    ...(run.color ? { color: run.color } : {}),
    ...(run.highlight ? { backgroundColor: run.highlight } : {}),
    ...(run.vertAlign ? { verticalAlign: run.vertAlign, fontSize: "0.75em" } : {}),
  };
}

function imageStyle(run: DocxRun): Record<string, string> {
  const image = run.image;
  if (!image) return {};
  return {
    // 声明了尺寸就按声明走，但绝不允许溢出正文宽度（窄面板下横向滚动比缩图难用）
    ...(image.width > 0 ? { width: px(image.width) } : {}),
    ...(image.height > 0 ? { height: px(image.height) } : {}),
    maxWidth: "100%",
    height: image.height > 0 ? px(image.height) : "auto",
    verticalAlign: "middle",
  };
}

/**
 * 深底单元格给一个浅色文字兜底。
 *
 * 表格底色常写在 `w:shd` 里而文字颜色留空（生成类文档尤其如此），照搬的结果是黑字压黑底 ——
 * 内容在 DOM 里但人看不见，等于没渲染。只在 run 自己没声明颜色时生效：`color` 设在 td 上，
 * run 有 `color` 就会覆盖它，所以绝不会篡改文档里写明的颜色。
 */
function cellStyle(fill: string | null): Record<string, string> {
  return {
    padding: "5px 8px",
    verticalAlign: "top",
    border: "1px solid rgba(0, 0, 0, 0.15)",
    ...(fill ? { backgroundColor: fill, ...(isDark(fill) ? { color: "#FAFAF9" } : {}) } : {}),
  };
}

/** 相对亮度低于 0.5 视为深色（ITU-R BT.601 的感知权重）。 */
function isDark(color: string): boolean {
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return false;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}
</script>

<template>
  <template v-for="(block, index) in blocks" :key="index">
    <p v-if="block.kind === 'paragraph'" data-testid="docx-paragraph" :style="paragraphStyle(block)">
      <!-- 列表符号用 span 而非 <ul>/<ol>：docx 的编号是段落属性，同一列表可能被普通段落打断 -->
      <span v-if="block.list" aria-hidden="true" class="me-[0.5em] inline-block">{{ block.list.marker }}</span>
      <template v-for="(run, runIndex) in block.runs" :key="runIndex">
        <img v-if="run.image" data-testid="docx-image" :src="run.image.src" :alt="run.image.alt" :style="imageStyle(run)" />
        <a
          v-else-if="run.link && safeHref(run.link)"
          :href="safeHref(run.link)"
          target="_blank"
          rel="noreferrer noopener"
          class="text-cyan underline"
          :style="runStyle(run)"
          >{{ run.text }}</a
        >
        <span v-else :style="runStyle(run)">{{ run.text }}</span>
      </template>
      <!-- 空段落要占一行高，否则原文的空行间距全部塌掉 -->
      <br v-if="block.runs.length === 0" />
    </p>

    <table v-else data-testid="docx-table" :style="{ borderCollapse: 'collapse', width: '100%', margin: '8px 0', tableLayout: 'fixed' }">
      <colgroup>
        <col v-for="(width, colIndex) in block.colWidths" :key="colIndex" :style="{ width: `${width}px` }" />
      </colgroup>
      <tbody>
        <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
          <template v-for="(cell, cellIndex) in row.cells" :key="cellIndex">
            <td
              v-if="!cell.covered"
              :colspan="cell.colSpan > 1 ? cell.colSpan : undefined"
              :rowspan="cell.rowSpan > 1 ? cell.rowSpan : undefined"
              :style="cellStyle(cell.fill)"
            >
              <DocxBlocks :blocks="cell.blocks" />
            </td>
          </template>
        </tr>
      </tbody>
    </table>
  </template>
</template>
