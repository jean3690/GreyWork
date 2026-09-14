/**
 * 预览选区的语义解析与浮层定位（纯逻辑，`*.dom.test` 与 node 测试都能直接跑）。
 *
 * **设计要点：让 DOM 自描述，而不是按渲染器写分支。**
 * 四种渲染器的 DOM 天差地别 —— markdown 是真 `<h1>`/`<li>`，docx 的标题与正文都是
 * `<p data-testid="docx-paragraph">`（层级只存在于模型里），pptx 是缩放过的绝对定位盒子，
 * 网页正文是一个 `<pre>`。与其写四套解析，不如在渲染时把语义补到 DOM 上，
 * 这里只做一次通用回溯。
 *
 * 两个属性是这套做法的关键：
 * - `data-selection-role`：显式覆盖。网页正文的 `<pre>` 不标就会被当代码。
 * - `data-selection-exclude`：从「整块文本」采集里剔除（代码行号槽、diff 行号）。
 *   刻意**不用** `aria-hidden` 当信号 —— docx 的列表符号 span 也是 `aria-hidden`，
 *   但那是用户看得见的圆点，必须保留。
 */

export type SelectionRole = "heading" | "paragraph" | "list-item" | "table-cell" | "code" | "block";

export interface SemanticUnit {
  role: SelectionRole;
  /** 标题层级 1–6；非标题为 null。 */
  level: number | null;
  /** 列表缩进层级（0 起）；非列表项为 null。 */
  listLevel: number | null;
  /** 命中的语义元素；回落 `block` 时为 null。 */
  element: Element | null;
  /**
   * 最近祖先上的 `data-selection-location`，用作来源行里的位置描述。
   * 给「DOM 里推不出位置」的渲染器用：PDF 的文本层没有标题结构，靠它标「第 N 页」。
   */
  location: string | null;
}

/**
 * 选区语义能否从 DOM 拿到。
 *
 * 排除的三种不是「偷懒」，是真的拿不到：
 * - `xlsx`：Univer 是 canvas 渲染，没有对应单元格的 DOM 节点（走它自己的选区服务，
 *   入口在 SheetViewer 的表头按钮，不经过本模块）；
 * - `image` / `legacy-office`：本来就没有可选文本。
 */
export function isTextSelectableKind(kind: string): boolean {
  return kind !== "xlsx" && kind !== "image" && kind !== "legacy-office";
}

const ROLE_OVERRIDES: ReadonlySet<string> = new Set(["paragraph", "code", "block"]);

function startElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
}

function roleOf(element: Element): SelectionRole | null {
  const override = element.getAttribute("data-selection-role");
  if (override && ROLE_OVERRIDES.has(override)) return override as SelectionRole;

  if (element.hasAttribute("data-heading")) return "heading";
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (element.hasAttribute("data-list-level") || tag === "li") return "list-item";
  if (tag === "td" || tag === "th") return "table-cell";
  if (tag === "pre" || tag === "code" || element.classList.contains("cm-content")) return "code";
  if (tag === "p" || tag === "blockquote") return "paragraph";
  return null;
}

function headingLevelOf(element: Element): number | null {
  const attr = element.getAttribute("data-heading");
  if (attr !== null) {
    const parsed = Number.parseInt(attr, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const match = /^h([1-6])$/.exec(element.tagName.toLowerCase());
  return match ? Number.parseInt(match[1], 10) : null;
}

/** 列表层级：优先模型给的值，否则数祖先里的列表容器。 */
function listLevelOf(element: Element): number {
  const attr = element.getAttribute("data-list-level");
  if (attr !== null) {
    const parsed = Number.parseInt(attr, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  let depth = -1;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") depth += 1;
  }
  return Math.max(0, depth);
}

/**
 * 从选区端点向上回溯到最近的语义单元。首个命中即返回（由内向外，所以嵌套表格取内层）。
 * 走到 scope 仍未命中即回落 `block` —— 跨多个语义块选择时也会落到这里。
 *
 * `location` 与语义角色**各自独立**地取最近值：角色按最近的命中算，位置按最近的
 * `data-selection-location` 算，两者不一定落在同一个元素上（PDF 的文本层两层都标，
 * 别的渲染器可能只在页面级标一次）。
 */
export function resolveSemanticUnit(node: Node | null, scope: Element): SemanticUnit {
  let element = startElement(node);
  let role: SelectionRole | null = null;
  let matched: Element | null = null;
  let location: string | null = null;

  while (element && element !== scope.parentElement) {
    if (!role) {
      const found = roleOf(element);
      if (found) {
        role = found;
        matched = element;
      }
    }
    if (location === null) {
      const declared = element.getAttribute("data-selection-location");
      if (declared) location = declared;
    }
    if (role && location !== null) break;
    element = element.parentElement;
  }

  if (!role || !matched) return { role: "block", level: null, listLevel: null, element: null, location };
  return {
    role,
    level: role === "heading" ? headingLevelOf(matched) : null,
    listLevel: role === "list-item" ? listLevelOf(matched) : null,
    element: matched,
    location,
  };
}

/**
 * 采集一个语义块的文本（用作上下文，不是用作附件正文）。
 *
 * 代码保留换行与缩进；其余折叠空白 —— HTML 源码里段落之间的换行缩进不是内容，
 * 照搬会把上下文撑成一堆空白。
 */
export function collectUnitText(element: Element, role: SelectionRole): string {
  const clone = element.cloneNode(true) as Element;
  for (const excluded of Array.from(clone.querySelectorAll("[data-selection-exclude]"))) {
    excluded.remove();
  }
  const text = clone.textContent ?? "";
  return role === "code" ? text.replace(/\s+$/, "") : text.replace(/\s+/g, " ").trim();
}

function isHeadingElement(element: Element): boolean {
  return element.hasAttribute("data-heading") || /^h[1-6]$/.test(element.tagName.toLowerCase());
}

/**
 * 向上逐层找「最近的前置标题」，作为附件里的来源面包屑。
 *
 * 只扫**前一个兄弟**，不递归进容器：docx 的段落与标题在 `<article>` 下平级，
 * markdown 的 `<p>` 与 `<h2>` 在根 div 下平级，两种主要场景都覆盖。
 * 深层的祖先可能包含标题，所以先看最内层 —— 更贴近选区的标题信息量更大。
 */
export function findPrecedingHeading(element: Element | null, scope: Element | null): string {
  for (let node = element; node && node !== scope; node = node.parentElement) {
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (isHeadingElement(sibling)) {
        const text = (sibling.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) return text;
      }
    }
  }
  return "";
}

export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ToolbarPlacement {
  /** 浮层**中心**的水平位置：组件配合 `translateX(-50%)` 使用。 */
  left: number;
  top: number;
  /** 因顶部空间不足翻到了选区下方。 */
  flipped: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * 浮层定位（纯几何，便于单测）。
 *
 * 默认摆在选区上方居中；顶部放不下就翻到下方。横向在最边缘处夹住，
 * 免得浮层有一半在视口外点不到。翻下去之后仍可能越界（选区本身很高），
 * 所以最后再夹一次纵向。
 */
export function placeToolbar(anchor: AnchorRect, viewport: ViewportSize, size: ViewportSize, gap = 8, margin = 8): ToolbarPlacement {
  const halfWidth = size.width / 2;
  const left = clamp(anchor.left + anchor.width / 2, margin + halfWidth, Math.max(margin + halfWidth, viewport.width - margin - halfWidth));

  let top = anchor.top - size.height - gap;
  let flipped = false;
  if (top < margin) {
    top = anchor.top + anchor.height + gap;
    flipped = true;
  }
  const maxTop = Math.max(margin, viewport.height - margin - size.height);
  return { left, top: clamp(top, margin, maxTop), flipped };
}
