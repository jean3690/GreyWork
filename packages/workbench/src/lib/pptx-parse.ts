/**
 * pptx（OOXML）→ 可直接用 DOM 渲染的幻灯片模型。
 *
 * 为什么自己解析而不喂 Univer Slides：Univer 0.25 的 slides 模块没有 preset（要手注册四个插件
 * 加三份 CSS），而且它的 ISlideData 只吃「一页一个富文本块」这种粗粒度结构 —— 位置、字号、
 * 表格、背景色在转换时就已经丢了。预览要的是「看到全部内容」，那就必须保留每个形状的几何与样式，
 * 于是模型直接对齐 CSS 能表达的东西：绝对定位矩形 + 文本 run + 表格 + 图片。
 *
 * 坐标单位统一换成 CSS px（EMU / 9525）：渲染层只需要一个整体缩放比例，不用再做单位换算。
 *
 * 明确不做的部分（不是疏漏，是取舍）：
 * - 自定义几何（a:custGeom）、图表（c:chart）、SmartArt、动画、过渡：按占位矩形渲染或跳过；
 * - 颜色的亮度修饰（lumMod / lumOff / tint / shade）：只取基色。近似色比「算错的色」好，
 *   而完整实现要把 HSL 变换链搬进来，收益与体积不成比例；
 * - 文本自动缩放（normAutofit）与 layout/master 的 lstStyle 默认字号继承：无显式 sz 时用 18pt 兜底。
 */
import JSZip from "jszip";

/** 1 CSS px = 9525 EMU（914400 EMU/inch ÷ 96 px/inch）。 */
const EMU_PER_PX = 9525;

/** 未声明字号时的兜底（pt）。PowerPoint 的正文默认是 18pt。 */
const DEFAULT_FONT_PT = 18;

/** 备注里要忽略的占位符类型：页码/日期/页眉页脚会混进 <a:t>，否则备注末尾会多出一个页码数字。 */
const NOTES_SKIP_PLACEHOLDERS = new Set(["sldNum", "dt", "ftr", "hdr"]);

export interface PptxRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 顺时针旋转角度（度）；0 = 不旋转。 */
  rotation: number;
}

export interface PptxRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** 字号（pt）；null = 继承兜底。 */
  sizePt: number | null;
  /** CSS 颜色串；null = 继承兜底。 */
  color: string | null;
  /** 字体名（latin typeface）；null = 用渲染端兜底字族。 */
  font: string | null;
}

export type PptxAlign = "start" | "center" | "end" | "justify";

export interface PptxParagraph {
  runs: PptxRun[];
  align: PptxAlign | null;
  /** 项目符号字符；null = 无符号。 */
  bullet: string | null;
  /** 段落左缩进（px），已含 marL。 */
  indent: number;
}

export type PptxAnchor = "start" | "center" | "end";

/** 预设几何的渲染近似：矩形 / 圆角矩形 / 椭圆，其余一律按矩形。 */
export type PptxGeometry = "rect" | "round" | "ellipse";

export interface PptxTextBox {
  kind: "text";
  rect: PptxRect;
  paragraphs: PptxParagraph[];
  anchor: PptxAnchor;
  fill: string | null;
  line: string | null;
  geometry: PptxGeometry;
}

export interface PptxPicture {
  kind: "image";
  rect: PptxRect;
  /** data: URL（图片字节直接从 zip 取 base64）。 */
  src: string;
  alt: string;
}

export interface PptxTableCell {
  paragraphs: PptxParagraph[];
  fill: string | null;
  colSpan: number;
  rowSpan: number;
  /** 被合并覆盖的单元格：不渲染（横向/纵向合并的续格）。 */
  covered: boolean;
}

export interface PptxTableRow {
  height: number;
  cells: PptxTableCell[];
}

export interface PptxTable {
  kind: "table";
  rect: PptxRect;
  colWidths: number[];
  rows: PptxTableRow[];
}

export interface PptxAutoShape {
  kind: "shape";
  rect: PptxRect;
  fill: string | null;
  line: string | null;
  geometry: PptxGeometry;
}

export type PptxElement = PptxTextBox | PptxPicture | PptxTable | PptxAutoShape;

export interface ParsedSlide {
  /** 1 开始的页序（按 sldIdLst 的真实顺序，不是文件名顺序）。 */
  index: number;
  background: string | null;
  elements: PptxElement[];
  notes: string | null;
}

export interface ParsedDeck {
  /** 页面尺寸（px）。 */
  width: number;
  height: number;
  slides: ParsedSlide[];
}

/* ===== DOM 辅助 ===== */

/**
 * 取去掉命名空间前缀的标签名。
 *
 * 不用 localName / getElementsByTagNameNS：不同 XML 解析器（浏览器 DOMParser 与测试用的
 * happy-dom）对未声明命名空间感知时的 localName 行为不一致，而 nodeName 一定是「前缀:本名」，
 * 剥前缀是唯一在两边都成立的做法。也顺带兼容用其他前缀的生产者。
 */
function local(node: Element): string {
  const name = node.nodeName;
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** 直接子元素中所有同名者。逐层取而非全树搜：避免把嵌套子形状的 a:off 当成自己的。 */
function kids(parent: Element | null, name: string): Element[] {
  if (!parent) return [];
  const out: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (local(child) === name) out.push(child);
  }
  return out;
}

function kid(parent: Element | null, name: string): Element | null {
  if (!parent) return null;
  for (const child of Array.from(parent.children)) {
    if (local(child) === name) return child;
  }
  return null;
}

/** 沿路径逐层下钻，任一层缺失即 null。 */
function pick(parent: Element | null, ...path: string[]): Element | null {
  let node = parent;
  for (const name of path) {
    node = kid(node, name);
    if (!node) return null;
  }
  return node;
}

function attr(el: Element | null, name: string): string | null {
  return el?.getAttribute(name) ?? null;
}

/**
 * 取关系引用属性（`r:embed` / `r:id`），按本名匹配、**带前缀的优先**。
 *
 * 两个坑叠在一起：`getAttribute("embed")` 取不到带前缀的属性；而写死 `"r:embed"` 又赌了
 * 生产者一定用 `r` 作前缀。更要命的是 `<p:sldId id="256" r:id="rId3"/>` 两个都有 ——
 * 无前缀的 `id` 是页号，拿它去查关系表必然落空，所以顺序不能反。
 */
function relAttr(el: Element | null, name: string): string | null {
  if (!el) return null;
  for (const item of Array.from(el.attributes)) {
    const colon = item.name.indexOf(":");
    if (colon !== -1 && item.name.slice(colon + 1) === name) return item.value;
  }
  return el.getAttribute(name);
}

/** OOXML 布尔属性可写 "1" 或 "true"。 */
function flag(el: Element | null, name: string): boolean {
  const value = attr(el, name);
  return value === "1" || value === "true";
}

function emu(value: string | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? n / EMU_PER_PX : 0;
}

function parseXml(text: string): Element | null {
  if (typeof DOMParser === "undefined") throw new Error("当前环境没有 DOMParser，无法解析 pptx");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc.documentElement ?? null;
}

/* ===== 颜色 ===== */

/** 主题色板：dk1/lt1/dk2/lt2/accent1..6/hlink/folHlink。 */
type ThemeColors = Record<string, string>;

/**
 * clrMap 的默认别名：bg1/tx1/bg2/tx2 是 schemeClr 里最常见的写法，
 * 但它们并不在 clrScheme 里，需要按 master 的 clrMap 折算（默认映射如下）。
 */
const SCHEME_ALIASES: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };

function colorFromNode(node: Element): string | null {
  const name = local(node);
  if (name === "srgbClr") {
    const hex = attr(node, "val");
    return hex ? `#${hex}` : null;
  }
  // sysClr 的 val 是系统色名（windowText 等），真实取值在 lastClr
  if (name === "sysClr") {
    const hex = attr(node, "lastClr");
    return hex ? `#${hex}` : null;
  }
  // prstClr 用的是 CSS 也认得的颜色名（red / cornflowerBlue…），直接交给浏览器
  if (name === "prstClr") return attr(node, "val");
  return null;
}

function parseThemeColors(theme: Element | null): ThemeColors {
  const scheme = pick(theme, "themeElements", "clrScheme");
  const colors: ThemeColors = {};
  if (!scheme) return colors;
  for (const slot of Array.from(scheme.children)) {
    for (const child of Array.from(slot.children)) {
      const color = colorFromNode(child);
      if (color) colors[local(slot)] = color;
      break;
    }
  }
  return colors;
}

/** 透明度修饰：srgbClr 下的 <a:alpha val="50000"/> 表示 50%。 */
function applyAlpha(color: string, node: Element): string {
  const alpha = attr(kid(node, "alpha"), "val");
  if (!alpha) return color;
  const ratio = Number(alpha) / 100000;
  if (!Number.isFinite(ratio) || ratio >= 1) return color;
  if (!color.startsWith("#") || color.length !== 7) return color;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, ratio).toFixed(3)})`;
}

/** 解析任意颜色容器（solidFill / bgRef / lnRef…）的第一个颜色子节点。 */
function resolveColor(container: Element | null, theme: ThemeColors): string | null {
  if (!container) return null;
  for (const child of Array.from(container.children)) {
    const name = local(child);
    if (name === "schemeClr") {
      const slot = attr(child, "val");
      if (!slot) continue;
      const hex = theme[SCHEME_ALIASES[slot] ?? slot] ?? theme[slot];
      return hex ? applyAlpha(hex, child) : null;
    }
    const direct = colorFromNode(child);
    if (direct) return applyAlpha(direct, child);
  }
  return null;
}

function solidFill(host: Element | null, theme: ThemeColors): string | null {
  return resolveColor(kid(host, "solidFill"), theme);
}

/** 描边颜色；a:ln 下 noFill 表示显式无边框。 */
function lineColor(spPr: Element | null, theme: ThemeColors): string | null {
  const ln = kid(spPr, "ln");
  if (!ln || kid(ln, "noFill")) return null;
  return solidFill(ln, theme);
}

/* ===== 几何 ===== */

const GEOMETRY_BY_PRESET: Record<string, PptxGeometry> = {
  roundRect: "round",
  round1Rect: "round",
  round2SameRect: "round",
  ellipse: "ellipse",
  oval: "ellipse",
};

function geometryOf(spPr: Element | null): PptxGeometry {
  const preset = attr(pick(spPr, "prstGeom"), "prst");
  return (preset ? GEOMETRY_BY_PRESET[preset] : undefined) ?? "rect";
}

/** 组合内坐标 → 幻灯片坐标的仿射变换（只有平移与缩放，pptx 组合不含斜切）。 */
interface Transform {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
}

const IDENTITY: Transform = { dx: 0, dy: 0, sx: 1, sy: 1 };

function applyTransform(rect: PptxRect, t: Transform): PptxRect {
  return {
    x: t.dx + rect.x * t.sx,
    y: t.dy + rect.y * t.sy,
    w: rect.w * t.sx,
    h: rect.h * t.sy,
    rotation: rect.rotation,
  };
}

/** 读 a:xfrm / p:xfrm；无 xfrm 返回 null（占位符要去 layout/master 继承）。 */
function rectOf(xfrm: Element | null): PptxRect | null {
  if (!xfrm) return null;
  const off = kid(xfrm, "off");
  const ext = kid(xfrm, "ext");
  if (!off && !ext) return null;
  // rot 单位是 1/60000 度
  const rotation = Number(attr(xfrm, "rot") ?? 0) / 60000;
  return {
    x: emu(attr(off, "x")),
    y: emu(attr(off, "y")),
    w: emu(attr(ext, "cx")),
    h: emu(attr(ext, "cy")),
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
}

/**
 * 组合形状（p:grpSp）的子坐标系映射。
 *
 * 组合自己有一套子坐标（chOff/chExt），子形状的坐标都在这套系里，
 * 必须按 ext/chExt 的比例缩放再平移到组合位置，否则整组元素会跑到画面外。
 */
function groupTransform(xfrm: Element | null, outer: Transform): Transform {
  const rect = rectOf(xfrm);
  const chOff = kid(xfrm, "chOff");
  const chExt = kid(xfrm, "chExt");
  if (!rect || !chExt) return outer;
  const childW = emu(attr(chExt, "cx"));
  const childH = emu(attr(chExt, "cy"));
  const sx = childW > 0 ? rect.w / childW : 1;
  const sy = childH > 0 ? rect.h / childH : 1;
  const childX = emu(attr(chOff, "x"));
  const childY = emu(attr(chOff, "y"));
  return {
    dx: outer.dx + (rect.x - childX * sx) * outer.sx,
    dy: outer.dy + (rect.y - childY * sy) * outer.sy,
    sx: sx * outer.sx,
    sy: sy * outer.sy,
  };
}

/* ===== 文本 ===== */

const ALIGN_MAP: Record<string, PptxAlign> = {
  l: "start",
  ctr: "center",
  r: "end",
  just: "justify",
  dist: "justify",
  justLow: "justify",
};

const ANCHOR_MAP: Record<string, PptxAnchor> = { t: "start", ctr: "center", b: "end" };

function runOf(node: Element, theme: ThemeColors, text: string): PptxRun {
  const rPr = kid(node, "rPr");
  const size = Number(attr(rPr, "sz"));
  // 只取 latin 字面字体名；主题字体（+mj-lt / +mn-lt）解析成实际字族要连 theme 的 fontScheme，
  // 而渲染端本来就要给一个兜底字族，收益太小，故不做。
  const typeface = attr(kid(rPr, "latin"), "typeface");
  return {
    text,
    bold: flag(rPr, "b"),
    italic: flag(rPr, "i"),
    underline: (attr(rPr, "u") ?? "none") !== "none",
    sizePt: Number.isFinite(size) && size > 0 ? size / 100 : null,
    color: solidFill(rPr, theme),
    font: typeface && !typeface.startsWith("+") ? typeface : null,
  };
}

function paragraphOf(p: Element, theme: ThemeColors): PptxParagraph {
  const pPr = kid(p, "pPr");
  const runs: PptxRun[] = [];
  for (const child of Array.from(p.children)) {
    const name = local(child);
    // a:fld 是域（页码、日期），结构与 a:r 相同，同样带可见文字
    if (name === "r" || name === "fld") {
      const text = kid(child, "t")?.textContent ?? "";
      if (text) runs.push(runOf(child, theme, text));
    } else if (name === "br") {
      // 段内换行：交给 CSS 的 pre-wrap，不另建段落（否则会多出一次段间距）
      runs.push({ text: "\n", bold: false, italic: false, underline: false, sizePt: null, color: null, font: null });
    }
  }
  const align = attr(pPr, "algn");
  const marL = Number(attr(pPr, "marL") ?? 0);
  return {
    runs,
    align: (align ? ALIGN_MAP[align] : undefined) ?? null,
    bullet: kid(pPr, "buNone") ? null : (attr(kid(pPr, "buChar"), "char") ?? (kid(pPr, "buAutoNum") ? "•" : null)),
    indent: Number.isFinite(marL) ? marL / EMU_PER_PX : 0,
  };
}

function paragraphsOf(txBody: Element | null, theme: ThemeColors): PptxParagraph[] {
  return kids(txBody, "p").map((p) => paragraphOf(p, theme));
}

function hasText(paragraphs: PptxParagraph[]): boolean {
  return paragraphs.some((p) => p.runs.some((run) => run.text.trim().length > 0));
}

/* ===== 占位符继承 ===== */

/** 占位符几何表：key 为 `type:idx` / `idx` / `type`，逐级回退查找。 */
type PlaceholderRects = Map<string, PptxRect>;

function placeholderKeys(ph: Element): string[] {
  const type = attr(ph, "type") ?? "body";
  const idx = attr(ph, "idx");
  return idx ? [`${type}:${idx}`, `#${idx}`, type] : [`${type}:`, type];
}

function collectPlaceholders(spTree: Element | null, into: PlaceholderRects): PlaceholderRects {
  for (const sp of kids(spTree, "sp")) {
    const ph = pick(sp, "nvSpPr", "nvPr", "ph");
    const rect = rectOf(pick(sp, "spPr", "xfrm"));
    if (!ph || !rect) continue;
    for (const key of placeholderKeys(ph)) {
      if (!into.has(key)) into.set(key, rect);
    }
  }
  return into;
}

function inheritedRect(sp: Element, placeholders: PlaceholderRects): PptxRect | null {
  const ph = pick(sp, "nvSpPr", "nvPr", "ph");
  if (!ph) return null;
  for (const key of placeholderKeys(ph)) {
    const hit = placeholders.get(key);
    if (hit) return hit;
  }
  return null;
}

/* ===== 关系与包内路径 ===== */

/** 解析 `../media/image1.png` 这类相对目标为包内绝对路径。 */
function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = base.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

interface Rels {
  /** rId → 包内绝对路径。 */
  byId: Map<string, string>;
  /** 关系类型末段（slideLayout / notesSlide / …）→ 包内绝对路径。 */
  byType: Map<string, string>;
}

function parseRels(xml: string | null, ownerPath: string): Rels {
  const byId = new Map<string, string>();
  const byType = new Map<string, string>();
  const root = xml ? parseXml(xml) : null;
  for (const rel of kids(root, "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) continue;
    // 外部关系（超链接等）不是包内文件，取了会指向不存在的 zip 条目
    if (attr(rel, "TargetMode") === "External") continue;
    const path = resolvePath(ownerPath, target);
    byId.set(id, path);
    const type = (attr(rel, "Type") ?? "").split("/").pop() ?? "";
    if (type && !byType.has(type)) byType.set(type, path);
  }
  return { byId, byType };
}

function relsPathOf(partPath: string): string {
  const at = partPath.lastIndexOf("/");
  return `${partPath.slice(0, at)}/_rels/${partPath.slice(at + 1)}.rels`;
}

/* ===== 图片 ===== */

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/* ===== 主流程 ===== */

interface SlideContext {
  theme: ThemeColors;
  placeholders: PlaceholderRects;
  /** rId → data URL（已解码的图片）。 */
  images: Map<string, string>;
}

function parseTable(frame: Element, theme: ThemeColors, transform: Transform): PptxTable | null {
  const tbl = pick(frame, "graphic", "graphicData", "tbl");
  if (!tbl) return null;
  const rect = rectOf(kid(frame, "xfrm"));
  if (!rect) return null;
  const colWidths = kids(kid(tbl, "tblGrid"), "gridCol").map((col) => emu(attr(col, "w")));
  const rows: PptxTableRow[] = kids(tbl, "tr").map((tr) => ({
    height: emu(attr(tr, "h")),
    cells: kids(tr, "tc").map((tc) => {
      const tcPr = kid(tc, "tcPr");
      return {
        paragraphs: paragraphsOf(kid(tc, "txBody"), theme),
        fill: solidFill(tcPr, theme),
        colSpan: Number(attr(tc, "gridSpan") ?? 1) || 1,
        rowSpan: Number(attr(tc, "rowSpan") ?? 1) || 1,
        // hMerge/vMerge 标记的是「被前一格吃掉」的续格，渲染时必须跳过
        covered: flag(tc, "hMerge") || flag(tc, "vMerge"),
      };
    }),
  }));
  const scaled = applyTransform(rect, transform);
  return { kind: "table", rect: scaled, colWidths: colWidths.map((w) => w * transform.sx), rows };
}

function parseShape(sp: Element, ctx: SlideContext, transform: Transform): PptxElement | null {
  const spPr = kid(sp, "spPr");
  const rect = rectOf(kid(spPr, "xfrm")) ?? inheritedRect(sp, ctx.placeholders);
  if (!rect) return null;
  const paragraphs = paragraphsOf(kid(sp, "txBody"), ctx.theme);
  const fill = solidFill(spPr, ctx.theme);
  const line = lineColor(spPr, ctx.theme);
  const geometry = geometryOf(spPr);
  const scaled = applyTransform(rect, transform);
  if (!hasText(paragraphs)) {
    // 纯装饰形状：没有填充也没有描边就没有任何视觉，直接丢掉（大量 pptx 带空占位框）
    if (!fill && !line) return null;
    return { kind: "shape", rect: scaled, fill, line, geometry };
  }
  const anchor = ANCHOR_MAP[attr(pick(sp, "txBody", "bodyPr"), "anchor") ?? "t"] ?? "start";
  return { kind: "text", rect: scaled, paragraphs, anchor, fill, line, geometry };
}

function parsePicture(pic: Element, ctx: SlideContext, transform: Transform): PptxPicture | null {
  const rect = rectOf(pick(pic, "spPr", "xfrm"));
  const embed = relAttr(pick(pic, "blipFill", "blip"), "embed");
  if (!rect || !embed) return null;
  const src = ctx.images.get(embed);
  if (!src) return null;
  return {
    kind: "image",
    rect: applyTransform(rect, transform),
    src,
    alt: attr(pick(pic, "nvPicPr", "cNvPr"), "name") ?? "图片",
  };
}

/** 递归遍历形状树（组合会带来新的坐标系）。 */
function collectElements(tree: Element | null, ctx: SlideContext, transform: Transform, out: PptxElement[]): void {
  if (!tree) return;
  for (const node of Array.from(tree.children)) {
    switch (local(node)) {
      case "sp": {
        const shape = parseShape(node, ctx, transform);
        if (shape) out.push(shape);
        break;
      }
      case "pic": {
        const picture = parsePicture(node, ctx, transform);
        if (picture) out.push(picture);
        break;
      }
      case "graphicFrame": {
        const table = parseTable(node, ctx.theme, transform);
        if (table) out.push(table);
        break;
      }
      case "grpSp":
        collectElements(node, ctx, groupTransform(pick(node, "grpSpPr", "xfrm"), transform), out);
        break;
      default:
        break;
    }
  }
}

/** 背景色：slide 自己的 bgPr 优先，其次 layout，最后 master（bgRef 走主题色板）。 */
function backgroundOf(roots: (Element | null)[], theme: ThemeColors): string | null {
  for (const root of roots) {
    const bg = pick(root, "cSld", "bg");
    if (!bg) continue;
    const direct = solidFill(kid(bg, "bgPr"), theme);
    if (direct) return direct;
    const ref = resolveColor(kid(bg, "bgRef"), theme);
    if (ref) return ref;
  }
  return null;
}

/** 备注文本：跳过页码/日期占位符，否则末尾会粘上页码数字。 */
function notesOf(notes: Element | null, theme: ThemeColors): string | null {
  if (!notes) return null;
  const lines: string[] = [];
  for (const sp of kids(pick(notes, "cSld", "spTree"), "sp")) {
    const type = attr(pick(sp, "nvSpPr", "nvPr", "ph"), "type");
    if (type && NOTES_SKIP_PLACEHOLDERS.has(type)) continue;
    for (const p of paragraphsOf(kid(sp, "txBody"), theme)) {
      const text = p.runs
        .map((run) => run.text)
        .join("")
        .trim();
      if (text) lines.push(text);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * 按 sldIdLst 的真实顺序取幻灯片路径。
 *
 * 不能按文件名排序：PowerPoint 调整页序时不会重命名 slideN.xml，只改 sldIdLst，
 * 按文件名排出来的顺序会和用户在 PowerPoint 里看到的不一致。
 *
 * sldIdLst 没覆盖到的 slide 部件仍按文件名补在后面 —— 关系表损坏时宁可页序不对，
 * 也不能整页消失（预览的底线是「内容都在」）。
 */
function slidePaths(presentation: Element | null, rels: Rels, zip: JSZip): string[] {
  const ordered: string[] = [];
  for (const sldId of kids(kid(presentation, "sldIdLst"), "sldId")) {
    const id = relAttr(sldId, "id");
    const path = id ? rels.byId.get(id) : undefined;
    if (path && zip.files[path] && !ordered.includes(path)) ordered.push(path);
  }
  const re = /^ppt\/slides\/slide(\d+)\.xml$/;
  const byName = Object.keys(zip.files)
    .filter((path) => re.test(path))
    .sort((a, b) => Number(re.exec(a)![1]) - Number(re.exec(b)![1]));
  for (const path of byName) {
    if (!ordered.includes(path)) ordered.push(path);
  }
  return ordered;
}

async function readText(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.files[path];
  return file ? file.async("text") : null;
}

async function readXml(zip: JSZip, path: string | undefined): Promise<Element | null> {
  if (!path) return null;
  const text = await readText(zip, path);
  return text ? parseXml(text) : null;
}

/** 解析 pptx 二进制为幻灯片模型。 */
export async function parsePptx(data: Uint8Array): Promise<ParsedDeck> {
  const zip = await JSZip.loadAsync(data);

  const presentationPath = "ppt/presentation.xml";
  const presentation = await readXml(zip, presentationPath);
  const presentationRels = parseRels(await readText(zip, relsPathOf(presentationPath)), presentationPath);

  const sldSz = kid(presentation, "sldSz");
  // 缺 sldSz 时按 16:9 的 10in × 5.625in 兜底（pptxgenjs 的 LAYOUT_16x9 就是这个尺寸）
  const width = emu(attr(sldSz, "cx")) || 960;
  const height = emu(attr(sldSz, "cy")) || 540;

  const themeRoot = await readXml(zip, presentationRels.byType.get("theme"));
  const theme = parseThemeColors(themeRoot);

  const slides: ParsedSlide[] = [];
  const paths = slidePaths(presentation, presentationRels, zip);

  for (let i = 0; i < paths.length; i++) {
    const slidePath = paths[i];
    const slide = await readXml(zip, slidePath);
    if (!slide) continue;
    const rels = parseRels(await readText(zip, relsPathOf(slidePath)), slidePath);

    const layoutPath = rels.byType.get("slideLayout");
    const layout = await readXml(zip, layoutPath);
    const layoutRels = layoutPath ? parseRels(await readText(zip, relsPathOf(layoutPath)), layoutPath) : null;
    const masterPath = layoutRels?.byType.get("slideMaster");
    const master = await readXml(zip, masterPath);

    // 占位符几何：layout 优先于 master（layout 是更具体的一层）
    const placeholders = collectPlaceholders(pick(layout, "cSld", "spTree"), new Map());
    collectPlaceholders(pick(master, "cSld", "spTree"), placeholders);

    // 图片按需解码：只取本页真正引用到的 rId，避免整包 media 都转成 base64
    const images = new Map<string, string>();
    for (const [id, path] of rels.byId) {
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const mime = IMAGE_MIME[ext];
      const file = zip.files[path];
      if (!mime || !file) continue;
      images.set(id, `data:${mime};base64,${await file.async("base64")}`);
    }

    const ctx: SlideContext = { theme, placeholders, images };
    const elements: PptxElement[] = [];
    collectElements(pick(slide, "cSld", "spTree"), ctx, IDENTITY, elements);

    slides.push({
      index: i + 1,
      background: backgroundOf([slide, layout, master], theme),
      elements,
      notes: notesOf(await readXml(zip, rels.byType.get("notesSlide")), theme),
    });
  }

  return { width, height, slides };
}

/** 段落的有效字号（pt）：取首个声明了 sz 的 run，否则兜底。 */
export function paragraphFontPt(paragraph: PptxParagraph): number {
  for (const run of paragraph.runs) {
    if (run.sizePt) return run.sizePt;
  }
  return DEFAULT_FONT_PT;
}
