/**
 * 轻量 Markdown 解析器：源文本 → 结构化 Block[]，供 MarkdownText.vue 用模板渲染。
 *
 * 设计约束（沿用组件原有取向，勿改）：
 * - 不引入 markdown-it / marked 等依赖；
 * - 输出 AST 而非 HTML 字符串，渲染端不使用 v-html —— 内容来自模型输出，从根上规避注入。
 *
 * 与 CommonMark 的已知偏离（有意为之）：
 * - 段落内单换行保留为换行（chat 场景下 LLM 常靠换行分行，按 CommonMark 折成空格会读不通）；
 * - 斜体只认 `*x*`，不认 `_x_`；粗体只认 `**x**`，不认 `__x__`
 *   —— snake_case 标识符会被 `_` 规则误判成斜体，代价大于收益；
 * - 不支持 setext 标题、图片、脚注、HTML 内联。
 */

export type InlineToken =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "bold"; v: string }
  | { t: "italic"; v: string }
  | { t: "strike"; v: string }
  | { t: "link"; v: string; href: string };

/** 列表项：inline 为本项内容，children 为下一级嵌套列表（保证 ul/ol 语义正确，不用缩进假装层级）。 */
export interface ListItem {
  inline: InlineToken[];
  children: ListNode | null;
}

/** 一级列表：有序性与起始序号逐层独立，故 `1. a` 下可嵌 `- a1`。 */
export interface ListNode {
  ordered: boolean;
  start: number;
  items: ListItem[];
}

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { type: "p"; lines: InlineToken[][] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: InlineToken[] }
  | { type: "code"; lang: string; path?: string; codeLines: string[] }
  | ({ type: "list" } & ListNode)
  | { type: "quote"; lines: InlineToken[][] }
  | { type: "hr" }
  | { type: "table"; headers: InlineToken[][]; align: Align[]; rows: InlineToken[][][] };

/** 围栏 caption 形如 `src/main.ts` 时当作路径标签展示，而非语言名。 */
const PATH_LABEL = /^[\w.-]+[\\/][\w./-]+\.\w{1,8}$/;
/** 显式放行的协议；其余带 scheme 的（javascript: / data: / vbscript: …）一律降级为纯文本。 */
const SAFE_SCHEME = /^(https?|mailto):/i;
/** scheme 探测：冒号出现在第一个 / ? # 之前，才算带协议。 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 链接是否可渲染为 <a>。
 * 无 scheme 的相对路径（`./a.md`、`#anchor`、`docs/a.md`）放行；带 scheme 的只放行白名单。
 */
export function isSafeHref(href: string): boolean {
  if (!href) return false;
  // 先剥掉空白与控制字符再判协议，避免 `java\nscript:` / `java\x01script:` 之类绕过。
  // 用码点过滤而非字符类正则：控制字符写进正则会被 no-control-regex 拦下。
  const clean = Array.from(href)
    .filter((ch) => (ch.codePointAt(0) ?? 0) > 0x20)
    .join("");
  if (!clean) return false;
  if (!HAS_SCHEME.test(clean)) return true;
  return SAFE_SCHEME.test(clean);
}

const FENCE_RE = /^```(\S+)?[ \t]*(.*)$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const HR_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const QUOTE_RE = /^[ \t]*>[ \t]?(.*)$/;
const LIST_RE = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/;
const TABLE_DELIM_RE = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

// 顺序即优先级：`code` 先吃掉反引号内容，`**` 必须早于 `*`，否则粗体会被斜体规则切碎。
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(~~[^~]+?~~)|(\*[^*\n]+?\*)|(\[[^\]]*\]\([^)\s]*\))/g;

/** 行内标记解析：code / bold / strike / italic / link，其余原样落为 text。 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ t: "text", v: text.slice(last, index) });
    const raw = match[0];
    if (raw.startsWith("`")) tokens.push({ t: "code", v: raw.slice(1, -1) });
    else if (raw.startsWith("**")) tokens.push({ t: "bold", v: raw.slice(2, -2) });
    else if (raw.startsWith("~~")) tokens.push({ t: "strike", v: raw.slice(2, -2) });
    else if (raw.startsWith("*")) tokens.push({ t: "italic", v: raw.slice(1, -1) });
    else {
      const sep = raw.lastIndexOf("](");
      const href = raw.slice(sep + 2, -1).trim();
      const label = raw.slice(1, sep);
      if (isSafeHref(href)) tokens.push({ t: "link", v: label, href });
      else tokens.push({ t: "text", v: raw });
    }
    last = index + raw.length;
  }
  if (last < text.length) tokens.push({ t: "text", v: text.slice(last) });
  return tokens;
}

/** 缩进宽度：tab 记 4 列，用于判定列表嵌套层级。 */
function indentWidth(prefix: string): number {
  let width = 0;
  for (const ch of prefix) width += ch === "\t" ? 4 : 1;
  return width;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseAlign(line: string): Align[] {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/** 表头行判定需要前看一行对齐分隔行，单行无法判断。 */
function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1]);
}

/** 该行是否开启一个新的块级结构（段落遇之即止）。 */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    line.trim().length === 0 ||
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    LIST_RE.test(line) ||
    QUOTE_RE.test(line) ||
    isTableStart(lines, i)
  );
}

interface ListRow {
  depth: number;
  ordered: boolean;
  num: number;
  text: string;
}

/**
 * 递归折树：从 rows[start] 起吃掉同层及更深的行，返回本层列表与下一个待处理下标。
 * 同层遇有序/无序切换即收尾，交回调用方另起一个列表块（ol 里混 ul 项是非法结构）。
 */
function buildListNode(rows: ListRow[], start: number): { node: ListNode; next: number } {
  const depth = rows[start].depth;
  const node: ListNode = { ordered: rows[start].ordered, start: rows[start].num, items: [] };
  let i = start;
  while (i < rows.length) {
    const row = rows[i];
    if (row.depth < depth) break;
    if (row.depth > depth) {
      const parent = node.items[node.items.length - 1];
      const sub = buildListNode(rows, i);
      if (!parent) break;
      // 缩进不规整时同一父项可能拿到多段子列表，合并而非覆盖，避免丢内容
      if (parent.children) parent.children.items.push(...sub.node.items);
      else parent.children = sub.node;
      i = sub.next;
      continue;
    }
    if (row.ordered !== node.ordered) break;
    node.items.push({ inline: parseInline(row.text), children: null });
    i += 1;
  }
  return { node, next: i };
}

/** 源文本 → Block[]。逐行状态机，块级优先级：围栏 > 标题 > hr > 表格 > 列表 > 引用 > 段落。 */
export function parseBlocks(content: string): Block[] {
  const out: Block[] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块：内容原样保留，闭合围栏缺失时吃到文末（流式输出常见半截围栏）
    const fence = line.match(FENCE_RE);
    if (fence) {
      const lang = fence[1] ?? "";
      const caption = fence[2]?.trim() ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push({ type: "code", lang, path: PATH_LABEL.test(caption) ? caption : undefined, codeLines });
      continue;
    }

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      out.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        inline: parseInline(heading[2].trim()),
      });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push({ type: "hr" });
      i += 1;
      continue;
    }

    // 表格：当前行含 | 且下一行是对齐分隔行，两者缺一即退回普通段落
    if (isTableStart(lines, i)) {
      const headers = splitRow(line).map(parseInline);
      const align = parseAlign(lines[i + 1]);
      i += 2;
      const rows: InlineToken[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim().length > 0) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i += 1;
      }
      out.push({ type: "table", headers, align, rows });
      continue;
    }

    const list = line.match(LIST_RE);
    if (list) {
      // 先把连续列表行整段收下（不按有序性切断，否则 `1. a` 下的 `- a1` 会掉出嵌套），
      // 再由 buildListNode 按缩进折树、按同层有序性切块。
      const rows: ListRow[] = [];
      while (i < lines.length) {
        const item = lines[i].match(LIST_RE);
        if (!item) break;
        rows.push({
          depth: indentWidth(item[1]),
          ordered: item[3] !== undefined,
          num: item[3] !== undefined ? Number(item[3]) : 1,
          text: item[4],
        });
        i += 1;
      }
      let cursor = 0;
      while (cursor < rows.length) {
        const { node, next } = buildListNode(rows, cursor);
        out.push({ type: "list", ...node });
        // buildListNode 至少消费一行；此处兜底防御，避免异常缩进造成死循环
        cursor = next > cursor ? next : cursor + 1;
      }
      continue;
    }

    const quote = line.match(QUOTE_RE);
    if (quote) {
      const quoteLines: InlineToken[][] = [];
      while (i < lines.length) {
        const item = lines[i].match(QUOTE_RE);
        if (!item) break;
        quoteLines.push(parseInline(item[1]));
        i += 1;
      }
      out.push({ type: "quote", lines: quoteLines });
      continue;
    }

    // 段落：吃到空行或下一个块级起始为止，内部换行保留
    const paraLines: InlineToken[][] = [];
    while (i < lines.length) {
      if (startsBlock(lines, i)) break;
      paraLines.push(parseInline(lines[i]));
      i += 1;
    }
    // 兜底：理论上不可达（块级分支已在前面全部拦截），但空推进会死循环，宁可显式跳行
    if (paraLines.length === 0) {
      i += 1;
      continue;
    }
    out.push({ type: "p", lines: paraLines });
  }

  return out;
}
