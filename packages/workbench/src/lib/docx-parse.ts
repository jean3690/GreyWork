/**
 * docx（OOXML WordprocessingML）→ 可直接用 DOM 渲染的文档模型。
 *
 * 为什么不再喂 Univer Docs：旧实现用正则抓 `w:p`，而表格单元格里的段落同样是 `w:p` ——
 * 一份带表格的文档会被拍平成一串松散段落，表格结构、图片、列表编号全部丢失。
 * docx 本质是流式文档，正是 HTML 的主场：段落→`<p>`、表格→`<table>`、图片→`<img>`，
 * 保真度和实现成本都比往富文本编辑器的私有快照里塞结构划算。
 *
 * 单位换算：长度用 twip（1/20 pt），字号用半磅，图片尺寸用 EMU；一律换成 CSS px / pt 后交给渲染层。
 *
 * 明确不做的部分（不是疏漏，是取舍）：
 * - 分栏、页眉页脚、脚注尾注、文本框浮动定位、域代码（除超链接）：预览按正文流呈现；
 * - 主题字体（`w:asciiTheme`）与主题色（`w:themeColor`）只取字面值，不查 theme1.xml；
 * - 制表位对齐：`w:tab` 渲染为空白，不做 tab stop 计算。
 */
import JSZip from "jszip";
import { attr, boolAttr, decodeImages, emuToPx, kid, kids, local, readRels, readXml, relAttr, twipToPx } from "./ooxml";

/** 缺少 sectPr 时的正文宽度（px）：A4 纵向去掉 1 英寸页边距 ≈ 794 - 192。 */
const DEFAULT_CONTENT_WIDTH = 602;

/** Word 默认正文字号（pt）。docDefaults 缺失时兜底。 */
const DEFAULT_FONT_PT = 11;

export interface DocxImage {
  /** data: URL。 */
  src: string;
  /** 显示尺寸（px）；0 = 未声明，交给渲染层按自然尺寸。 */
  width: number;
  height: number;
  alt: string;
}

export interface DocxRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** 字号（pt）；null = 继承段落/默认。 */
  sizePt: number | null;
  color: string | null;
  /** 文字底色（w:highlight 或 w:shd fill）。 */
  highlight: string | null;
  font: string | null;
  vertAlign: "super" | "sub" | null;
  /** 内联图片；有图时 text 为空。 */
  image: DocxImage | null;
  /** 外部超链接目标。 */
  link: string | null;
}

export type DocxAlign = "start" | "center" | "end" | "justify";

export interface DocxList {
  /** 渲染用的项目符号 / 编号文本。 */
  marker: string;
  /** 缩进层级（0 开始）。 */
  level: number;
  ordered: boolean;
}

export interface DocxParagraph {
  kind: "paragraph";
  runs: DocxRun[];
  align: DocxAlign | null;
  /** 标题层级 1–6；null = 正文。 */
  heading: number | null;
  /** 左缩进（px，含列表层级缩进）。 */
  indent: number;
  list: DocxList | null;
  /** 段前/段后间距（px）。 */
  spaceBefore: number;
  spaceAfter: number;
}

export interface DocxTableCell {
  blocks: DocxBlock[];
  colSpan: number;
  /** 纵向合并的续格：不渲染（被上一格的 rowSpan 覆盖）。 */
  covered: boolean;
  /** 纵向合并起点跨的行数。 */
  rowSpan: number;
  fill: string | null;
  /** 列宽（px）；null = 未声明。 */
  width: number | null;
}

export interface DocxTableRow {
  cells: DocxTableCell[];
}

export interface DocxTable {
  kind: "table";
  rows: DocxTableRow[];
  /** tblGrid 声明的列宽（px）。 */
  colWidths: number[];
}

export type DocxBlock = DocxParagraph | DocxTable;

export interface ParsedDocx {
  blocks: DocxBlock[];
  /** 正文宽度（px）：页宽减左右页边距，用作渲染容器的最大宽度。 */
  contentWidth: number;
}

/* ===== 样式表 ===== */

/** 一条段落/字符样式里我们关心的部分。 */
interface StyleEntry {
  id: string;
  name: string;
  basedOn: string | null;
  /** 从 w:outlineLvl 或样式名推出的标题层级（1–6）。 */
  heading: number | null;
  rPr: Element | null;
  pPr: Element | null;
}

interface StyleTable {
  byId: Map<string, StyleEntry>;
  /** docDefaults 的字符属性（正文字号/字体的真正来源）。 */
  defaultRPr: Element | null;
}

function headingOf(styleId: string, name: string, pPr: Element | null): number | null {
  // 先判存在再转数字：`Number(null)` 是 0，会把每个没写 outlineLvl 的样式都判成一级标题，
  // 于是满篇正文渲染成巨大标题。
  const outlineValue = relAttr(kid(pPr, "outlineLvl"), "val");
  if (outlineValue !== null) {
    const outline = Number(outlineValue);
    if (Number.isFinite(outline) && outline >= 0 && outline <= 5) return outline + 1;
  }
  // 样式名比 id 可靠：id 可能被本地化或改名，而内置名固定是 "heading 1"
  const match = /^(?:heading|标题)\s*([1-6])$/i.exec(name) ?? /^Heading([1-6])$/i.exec(styleId);
  return match ? Number(match[1]) : null;
}

function parseStyles(root: Element | null): StyleTable {
  const byId = new Map<string, StyleEntry>();
  for (const style of kids(root, "style")) {
    const id = relAttr(style, "styleId");
    if (!id) continue;
    const pPr = kid(style, "pPr");
    const name = relAttr(kid(style, "name"), "val") ?? "";
    byId.set(id, {
      id,
      name,
      basedOn: relAttr(kid(style, "basedOn"), "val"),
      heading: headingOf(id, name, pPr),
      rPr: kid(style, "rPr"),
      pPr,
    });
  }
  return { byId, defaultRPr: pick2(root, "docDefaults", "rPrDefault", "rPr") };
}

/** 三层下钻（ooxml 的 pick 需要 Element，这里容忍 null 根）。 */
function pick2(root: Element | null, a: string, b: string, c: string): Element | null {
  return kid(kid(kid(root, a), b), c);
}

/**
 * 沿 basedOn 链收集样式，最一般的排在前面。
 *
 * Word 的格式大量藏在样式里（Heading 1 的粗体与字号在 styles.xml，不在 run 上），
 * 不解析样式链的话标题会和正文一样大 —— 这是「看着不像原文」的最主要来源。
 */
function styleChain(table: StyleTable, styleId: string | null): StyleEntry[] {
  const chain: StyleEntry[] = [];
  const seen = new Set<string>();
  let current = styleId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const entry = table.byId.get(current);
    if (!entry) break;
    chain.unshift(entry);
    current = entry.basedOn;
  }
  return chain;
}

/* ===== 列表编号 ===== */

interface NumberingLevel {
  ordered: boolean;
  /** bullet 的字符，或 decimal 之类的格式名。 */
  format: string;
  lvlText: string;
}

/** numId → ilvl → 级别定义。 */
type Numbering = Map<string, Map<number, NumberingLevel>>;

const BULLET_FALLBACK = "•";

/** Symbol 字体的私用区码位（Wingdings 等）落到浏览器里是豆腐块，统一换成通用符号。 */
function normalizeBullet(text: string): string {
  const first = text.trim().charAt(0);
  if (!first) return BULLET_FALLBACK;
  const code = first.codePointAt(0) ?? 0;
  return code >= 0xe000 && code <= 0xf8ff ? BULLET_FALLBACK : first;
}

function parseNumbering(root: Element | null): Numbering {
  const abstracts = new Map<string, Map<number, NumberingLevel>>();
  for (const abstract of kids(root, "abstractNum")) {
    const id = relAttr(abstract, "abstractNumId");
    if (!id) continue;
    const levels = new Map<number, NumberingLevel>();
    for (const lvl of kids(abstract, "lvl")) {
      const ilvl = Number(relAttr(lvl, "ilvl") ?? 0);
      const format = relAttr(kid(lvl, "numFmt"), "val") ?? "decimal";
      const lvlText = relAttr(kid(lvl, "lvlText"), "val") ?? "";
      levels.set(Number.isFinite(ilvl) ? ilvl : 0, {
        ordered: format !== "bullet" && format !== "none",
        format,
        lvlText,
      });
    }
    abstracts.set(id, levels);
  }

  // w:num 是「实例」，指向 abstractNum；段落里引用的是实例 id
  const numbering: Numbering = new Map();
  for (const num of kids(root, "num")) {
    const numId = relAttr(num, "numId");
    const abstractId = relAttr(kid(num, "abstractNumId"), "val");
    if (!numId || !abstractId) continue;
    const levels = abstracts.get(abstractId);
    if (levels) numbering.set(numId, levels);
  }
  return numbering;
}

/* ===== 运行时上下文 ===== */

interface DocxContext {
  styles: StyleTable;
  numbering: Numbering;
  /** rId → data URL。 */
  images: Map<string, string>;
  /** rId → 外部超链接目标。 */
  links: Map<string, string>;
  /** 有序列表的计数器：`numId:ilvl` → 已出现次数。 */
  counters: Map<string, number>;
}

/* ===== run ===== */

const UNDERLINE_NONE = new Set(["none", "0", "false"]);

/** 半磅 → 磅。 */
function halfPointToPt(value: string | null): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n / 2 : null;
}

function hexColor(value: string | null): string | null {
  if (!value || value === "auto") return null;
  return /^[0-9A-Fa-f]{6}$/.test(value) ? `#${value.toUpperCase()}` : null;
}

/** 从一串 rPr（样式链在前、直接格式在后）叠出最终字符样式。 */
function mergeRunProps(sources: (Element | null)[]): Omit<DocxRun, "text" | "image" | "link"> {
  const merged: Omit<DocxRun, "text" | "image" | "link"> = {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    sizePt: null,
    color: null,
    highlight: null,
    font: null,
    vertAlign: null,
  };
  for (const rPr of sources) {
    if (!rPr) continue;
    // `<w:b/>` 无 val 即为真；`<w:b w:val="0"/>` 是显式关闭 —— 后者必须能覆盖样式里的真
    const bold = kid(rPr, "b");
    if (bold) merged.bold = relAttr(bold, "val") === null ? true : boolAttr(bold, "w:val") || boolAttr(bold, "val");
    const italic = kid(rPr, "i");
    if (italic) merged.italic = relAttr(italic, "val") === null ? true : boolAttr(italic, "w:val") || boolAttr(italic, "val");
    const strike = kid(rPr, "strike");
    if (strike) merged.strike = relAttr(strike, "val") === null ? true : boolAttr(strike, "w:val") || boolAttr(strike, "val");
    const underline = kid(rPr, "u");
    if (underline) {
      const value = relAttr(underline, "val");
      merged.underline = value === null ? true : !UNDERLINE_NONE.has(value);
    }
    const size = halfPointToPt(relAttr(kid(rPr, "sz"), "val"));
    if (size !== null) merged.sizePt = size;
    const color = hexColor(relAttr(kid(rPr, "color"), "val"));
    if (color) merged.color = color;
    const highlight = relAttr(kid(rPr, "highlight"), "val");
    if (highlight && highlight !== "none") merged.highlight = highlight;
    const shading = hexColor(relAttr(kid(rPr, "shd"), "fill"));
    if (shading) merged.highlight = shading;
    const fonts = kid(rPr, "rFonts");
    const font = relAttr(fonts, "ascii") ?? relAttr(fonts, "hAnsi") ?? relAttr(fonts, "eastAsia");
    if (font) merged.font = font;
    const vert = relAttr(kid(rPr, "vertAlign"), "val");
    if (vert === "superscript") merged.vertAlign = "super";
    else if (vert === "subscript") merged.vertAlign = "sub";
    else if (vert === "baseline") merged.vertAlign = null;
  }
  return merged;
}

/** 一个 w:r 的可见文本：w:t 正文 + 制表符 + 换行。 */
function runText(r: Element): string {
  let out = "";
  for (const child of Array.from(r.children)) {
    const name = local(child);
    if (name === "t") out += child.textContent ?? "";
    else if (name === "tab") out += "\t";
    else if (name === "br" || name === "cr") out += "\n";
    // w:noBreakHyphen / w:softHyphen：前者是真连字符，后者不可见
    else if (name === "noBreakHyphen") out += "-";
  }
  return out;
}

/** 内联图片：新式 w:drawing 与旧式 w:pict 都要认（Word 2003 转存的文档全是后者）。 */
function runImage(r: Element, ctx: DocxContext): DocxImage | null {
  const blip = findDescendant(r, "blip");
  const embed = blip ? relAttr(blip, "embed") : null;
  if (embed) {
    const src = ctx.images.get(embed);
    if (!src) return null;
    const extent = findDescendant(r, "extent");
    const docPr = findDescendant(r, "docPr");
    return {
      src,
      width: extent ? emuToPx(attr(extent, "cx")) : 0,
      height: extent ? emuToPx(attr(extent, "cy")) : 0,
      alt: relAttr(docPr, "descr") ?? relAttr(docPr, "name") ?? "图片",
    };
  }
  const imageData = findDescendant(r, "imagedata");
  const legacy = imageData ? relAttr(imageData, "id") : null;
  if (legacy) {
    const src = ctx.images.get(legacy);
    if (src) return { src, width: 0, height: 0, alt: relAttr(imageData, "title") ?? "图片" };
  }
  return null;
}

/** 后代里第一个同本名的元素（图片相关节点埋在 drawing/inline/graphic 好几层里）。 */
function findDescendant(root: Element | null, name: string): Element | null {
  if (!root) return null;
  for (const child of Array.from(root.children)) {
    if (local(child) === name) return child;
    const hit = findDescendant(child, name);
    if (hit) return hit;
  }
  return null;
}

function buildRun(r: Element, ctx: DocxContext, inherited: (Element | null)[], link: string | null): DocxRun | null {
  const image = runImage(r, ctx);
  const text = runText(r);
  if (!image && !text) return null;
  return { ...mergeRunProps([...inherited, kid(r, "rPr")]), text: image ? "" : text, image, link };
}

/* ===== 段落 ===== */

const ALIGN_MAP: Record<string, DocxAlign> = {
  left: "start",
  start: "start",
  center: "center",
  right: "end",
  end: "end",
  both: "justify",
  distribute: "justify",
};

/** 编号文本：把 `%1.` 之类的占位符替换成当前计数。多级编号只填当前级，够用且不会算错。 */
function orderedMarker(level: NumberingLevel, index: number, ilvl: number): string {
  const value = formatNumber(index, level.format);
  const text = level.lvlText.replace(new RegExp(`%${ilvl + 1}`, "g"), value);
  return text.includes(value) ? text : `${value}.`;
}

const LOWER_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const ROMAN: [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function toRoman(value: number): string {
  let rest = value;
  let out = "";
  for (const [amount, glyph] of ROMAN) {
    while (rest >= amount) {
      out += glyph;
      rest -= amount;
    }
  }
  return out;
}

function formatNumber(index: number, format: string): string {
  switch (format) {
    case "lowerLetter":
      return LOWER_LETTERS[(index - 1) % 26];
    case "upperLetter":
      return LOWER_LETTERS[(index - 1) % 26].toUpperCase();
    case "lowerRoman":
      return toRoman(index);
    case "upperRoman":
      return toRoman(index).toUpperCase();
    case "chineseCounting":
    case "chineseCountingThousand":
      return "一二三四五六七八九十".charAt(index - 1) || String(index);
    default:
      return String(index);
  }
}

function listOf(pPr: Element | null, ctx: DocxContext, styleChainEntries: StyleEntry[]): DocxList | null {
  // 列表引用可能只写在样式里（Word 的「列表段落」样式），所以样式链也要看
  const numPr = kid(pPr, "numPr") ?? styleChainEntries.map((entry) => kid(entry.pPr, "numPr")).find(Boolean) ?? null;
  if (!numPr) return null;
  const numId = relAttr(kid(numPr, "numId"), "val");
  if (!numId || numId === "0") return null;
  const ilvl = Number(relAttr(kid(numPr, "ilvl"), "val") ?? 0);
  const level = ctx.numbering.get(numId)?.get(Number.isFinite(ilvl) ? ilvl : 0);
  if (!level) return { marker: BULLET_FALLBACK, level: Number.isFinite(ilvl) ? ilvl : 0, ordered: false };
  const depth = Number.isFinite(ilvl) ? ilvl : 0;
  if (!level.ordered) return { marker: normalizeBullet(level.lvlText), level: depth, ordered: false };
  const key = `${numId}:${depth}`;
  const next = (ctx.counters.get(key) ?? 0) + 1;
  ctx.counters.set(key, next);
  // 进入更浅的层级时重置更深层的计数（1.1 → 2 之后，2.1 要从 1 开始）
  for (const existing of [...ctx.counters.keys()]) {
    const [id, lvl] = existing.split(":");
    if (id === numId && Number(lvl) > depth) ctx.counters.delete(existing);
  }
  return { marker: orderedMarker(level, next, depth), level: depth, ordered: true };
}

function parseParagraph(p: Element, ctx: DocxContext): DocxParagraph {
  const pPr = kid(p, "pPr");
  const styleId = relAttr(kid(pPr, "pStyle"), "val");
  const chain = styleChain(ctx.styles, styleId);
  // 字符样式的叠加顺序：docDefaults → 段落样式链 → run 自己的 rPr → 段落标记 rPr 不参与正文
  const inherited: (Element | null)[] = [ctx.styles.defaultRPr, ...chain.map((entry) => entry.rPr)];

  const runs: DocxRun[] = [];
  for (const child of Array.from(p.children)) {
    const name = local(child);
    if (name === "r") {
      const run = buildRun(child, ctx, inherited, null);
      if (run) runs.push(run);
    } else if (name === "hyperlink") {
      // 超链接是容器，内部照旧是 w:r；外部目标经关系表解析
      const target = ctx.links.get(relAttr(child, "id") ?? "") ?? null;
      for (const inner of kids(child, "r")) {
        const run = buildRun(inner, ctx, inherited, target);
        if (run) runs.push(run);
      }
    } else if (name === "ins" || name === "smartTag" || name === "sdt" || name === "sdtContent") {
      // 修订插入 / 智能标记 / 内容控件：把内部 run 视作正文（删除标记 w:del 则跳过）
      for (const inner of kids(child, "r")) {
        const run = buildRun(inner, ctx, inherited, null);
        if (run) runs.push(run);
      }
    } else if (name === "fldSimple") {
      for (const inner of kids(child, "r")) {
        const run = buildRun(inner, ctx, inherited, null);
        if (run) runs.push(run);
      }
    }
  }

  const chainPPr = chain.map((entry) => entry.pPr);
  const alignValue = firstAttr([...chainPPr, pPr], "jc", "val");
  const indentValue = firstAttr([...chainPPr, pPr], "ind", "left") ?? firstAttr([...chainPPr, pPr], "ind", "start");
  const spacing = [...chainPPr, pPr].reduce<Element | null>((found, node) => kid(node, "spacing") ?? found, null);
  const list = listOf(pPr, ctx, chain);
  const heading = chain.reduce<number | null>((found, entry) => entry.heading ?? found, null);

  return {
    kind: "paragraph",
    runs,
    align: (alignValue ? ALIGN_MAP[alignValue] : undefined) ?? null,
    heading,
    // 列表层级也吃缩进：Word 把它写在 numbering 里，这里按层级给固定步进，视觉上等价
    indent: twipToPx(indentValue) + (list ? list.level * 24 : 0),
    list,
    spaceBefore: twipToPx(relAttr(spacing, "before")),
    spaceAfter: twipToPx(relAttr(spacing, "after")),
  };
}

/** 在一串 pPr 里按「后者优先」找某个子标签的属性。 */
function firstAttr(sources: (Element | null)[], tag: string, name: string): string | null {
  let found: string | null = null;
  for (const source of sources) {
    const value = relAttr(kid(source, tag), name);
    if (value) found = value;
  }
  return found;
}

/* ===== 表格 ===== */

function parseTable(tbl: Element, ctx: DocxContext): DocxTable {
  const colWidths = kids(kid(tbl, "tblGrid"), "gridCol").map((col) => twipToPx(relAttr(col, "w")));
  const rows: DocxTableRow[] = [];

  for (const tr of kids(tbl, "tr")) {
    const cells: DocxTableCell[] = [];
    for (const tc of kids(tr, "tc")) {
      const tcPr = kid(tc, "tcPr");
      const vMerge = kid(tcPr, "vMerge");
      const vMergeVal = vMerge ? (relAttr(vMerge, "val") ?? "continue") : null;
      const span = Number(relAttr(kid(tcPr, "gridSpan"), "val") ?? 1);
      const width = relAttr(kid(tcPr, "tcW"), "w");
      const widthType = relAttr(kid(tcPr, "tcW"), "type");
      cells.push({
        blocks: parseBlocks(tc, ctx),
        colSpan: Number.isFinite(span) && span > 1 ? span : 1,
        // vMerge 无 val 或 val="continue" 都是「被上一格吃掉」；val="restart" 才是起点
        covered: vMergeVal === "continue",
        rowSpan: 1,
        fill: hexColor(relAttr(kid(tcPr, "shd"), "fill")),
        width: width && widthType !== "pct" && widthType !== "auto" ? twipToPx(width) : null,
      });
    }
    rows.push({ cells });
  }

  resolveRowSpans(rows);
  return { kind: "table", rows, colWidths };
}

/**
 * 把 vMerge 的续格折算成起始格的 rowSpan。
 *
 * HTML 只有 rowSpan，没有「续格」概念；不折算的话被合并的行会多出空单元格，整张表列错位。
 * 按列号对齐（含 gridSpan 占位），逐行往下数连续的续格。
 */
function resolveRowSpans(rows: DocxTableRow[]): void {
  const columnOf = (row: DocxTableRow): Map<number, DocxTableCell> => {
    const map = new Map<number, DocxTableCell>();
    let column = 0;
    for (const cell of row.cells) {
      map.set(column, cell);
      column += cell.colSpan;
    }
    return map;
  };
  const grids = rows.map(columnOf);
  for (let r = 0; r < grids.length; r++) {
    for (const [column, cell] of grids[r]) {
      if (cell.covered) continue;
      let span = 1;
      for (let next = r + 1; next < grids.length; next++) {
        const below = grids[next].get(column);
        if (!below?.covered) break;
        span += 1;
      }
      cell.rowSpan = span;
    }
  }
}

/* ===== 主流程 ===== */

function parseBlocks(container: Element | null, ctx: DocxContext): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  if (!container) return blocks;
  for (const child of Array.from(container.children)) {
    const name = local(child);
    if (name === "p") blocks.push(parseParagraph(child, ctx));
    else if (name === "tbl") blocks.push(parseTable(child, ctx));
    else if (name === "sdt") blocks.push(...parseBlocks(kid(child, "sdtContent"), ctx));
  }
  return blocks;
}

/** 正文宽度：页宽减左右页边距。sectPr 在 body 末尾。 */
function contentWidthOf(body: Element | null): number {
  const sectPr = kid(body, "sectPr");
  const pageWidth = twipToPx(relAttr(kid(sectPr, "pgSz"), "w"));
  if (pageWidth <= 0) return DEFAULT_CONTENT_WIDTH;
  const margins = kid(sectPr, "pgMar");
  const left = twipToPx(relAttr(margins, "left"));
  const right = twipToPx(relAttr(margins, "right"));
  const width = pageWidth - left - right;
  return width > 100 ? width : DEFAULT_CONTENT_WIDTH;
}

/** 解析 docx 二进制为文档模型。 */
export async function parseDocx(data: Uint8Array): Promise<ParsedDocx> {
  const zip = await JSZip.loadAsync(data);
  const documentPath = "word/document.xml";
  const root = await readXml(zip, documentPath);
  if (!root) return { blocks: [], contentWidth: DEFAULT_CONTENT_WIDTH };

  const rels = await readRels(zip, documentPath);
  const links = new Map<string, string>();
  // 外部超链接被 parseRels 过滤掉了（它只留包内文件），这里单独扫一遍拿 URL
  const relsRoot = await readXml(zip, `word/_rels/${documentPath.slice("word/".length)}.rels`);
  for (const rel of kids(relsRoot, "Relationship")) {
    if (attr(rel, "TargetMode") !== "External") continue;
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (id && target) links.set(id, target);
  }

  const ctx: DocxContext = {
    styles: parseStyles(await readXml(zip, "word/styles.xml")),
    numbering: parseNumbering(await readXml(zip, "word/numbering.xml")),
    images: await decodeImages(zip, rels),
    links,
    counters: new Map(),
  };

  const body = kid(root, "body");
  return { blocks: parseBlocks(body, ctx), contentWidth: contentWidthOf(body) };
}

/** run 的有效字号（pt）：自身声明优先，否则用 Word 默认正文字号。 */
export function runFontPt(run: DocxRun): number {
  return run.sizePt ?? DEFAULT_FONT_PT;
}

/** 标题层级 → 相对正文的字号倍率（Word 内置样式的观感比例）。 */
export const HEADING_SCALE: Readonly<Record<number, number>> = {
  1: 2,
  2: 1.5,
  3: 1.25,
  4: 1.1,
  5: 1,
  6: 1,
};
