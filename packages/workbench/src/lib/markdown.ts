/**
 * Markdown → Block[] 转换层（渲染由 MarkdownText.vue 等模板完成）。
 *
 * 引擎：marked（当前锁 v18）的词法分析器 —— marked.lexer() 产块级 token 树、
 * Lexer.inlineTokens() 产行内 token 流。本文件只消费 token/AST，从不经过 marked
 * 的 HTML 渲染器：输出仍是结构化 Block[]，模板端保持文本插值渲染。
 *
 * 安全模型（沿用组件取向，勿改）：
 * - 渲染端不使用 v-html，内容来自模型输出，从根上规避注入；
 * - raw HTML（块级与行内）与图片一律降级为字面文本（token.raw），绝无标签透传；
 * - 链接 href 过 isSafeHref 白名单（http/https/mailto 与相对路径），其余协议
 *   （javascript: / data: / vbscript: …，含控制字符混淆）整段降级为纯文本。
 *
 * 与 CommonMark / GFM 的关系：
 * - 块级与行内结构语义以 CommonMark + GFM 为准（setext 标题、表格、任务列表、
 *   自动链接、转义、引用定义解析等均由 marked 保证，不再维护手写偏离清单）；
 * - 保留的 chat 取向（渲染习惯，非语法偏离）：
 *   - 段落与引用内软换行按源行拆分，模板以 <br> 呈现可见换行（不折成空格）；
 *   - 行内格式扁平化：嵌套格式（如粗体内套斜体）外层胜出，v 只取可见文本；
 *   - 引用块内只做行内解析（引用中的块级语法标记保持字面可见）。
 *
 * 已知行为差异（相对旧手写解析器，均为向 CommonMark 靠拢）：
 * - `_斜体_`、setext 标题、图片/自动链接语法开始生效（图片仍按安全模型降级为字面）；
 * - `text\n---` 解析为 setext 标题而非分割线（`---` 前需空行才是 <hr>）；
 * - 链接引用定义行（`[id]: url`）不再渲染，引用处解析成真链接。
 */

import { Lexer, marked } from "marked";
import type { Token, Tokens } from "marked";

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

const LEX_OPTIONS = { gfm: true } as const;

/** 纯行内解析：块级语法惰性（标题/列表/围栏标记原样当文本），只认行内标记。 */
function inlineTokensOf(text: string): Token[] {
  return new Lexer(LEX_OPTIONS).inlineTokens(text);
}

/** 取 token 的可见文本：容器递归子节点，图片取 alt，HTML 标签取字面原文。 */
function textContent(t: Token): string {
  switch (t.type) {
    case "text":
    case "escape":
    case "codespan":
      return t.text;
    case "strong":
    case "em":
    case "del":
    case "link":
      return (t.tokens ?? []).map(textContent).join("");
    case "html":
      return t.text;
    case "image":
      return t.text;
    case "br":
      return "\n";
    default:
      return "";
  }
}

/** 单个 marked 行内 token → 模型 token。链接/图片/HTML 的安全降级都在这一层。 */
function toModelToken(t: Token): InlineToken {
  switch (t.type) {
    case "text":
    case "escape":
      return { t: "text", v: t.text };
    case "codespan":
      return { t: "code", v: t.text };
    case "strong":
      // 扁平化：嵌套行内格式（em/code/link…）外层胜出，v 取可见文本
      return { t: "bold", v: textContent(t) };
    case "em":
      return { t: "italic", v: textContent(t) };
    case "del":
      return { t: "strike", v: textContent(t) };
    case "link": {
      const v = textContent(t).replace(/\n/g, " ");
      if (isSafeHref(t.href)) return { t: "link", v, href: t.href };
      return { t: "text", v: t.raw };
    }
    case "br":
      return { t: "text", v: "\n" };
    default:
      // image / html（行内）按安全模型降级为字面原文；未知 token 同样只作文本
      return { t: "text", v: t.raw ?? "" };
  }
}

/** 行内 token 流 → 模型 token 流。 */
function toModelTokens(tokens: Token[]): InlineToken[] {
  const out: InlineToken[] = [];
  for (const t of tokens) out.push(toModelToken(t));
  return out;
}

/**
 * 按软换行把扁平 token 流拆成行数组：任何 token 的 v 内含 \n 都在该处断行
 * （br 已映射成 v="\n"），每行拿到独立 token —— 段落/引用模板用 <br> 连接行。
 */
function splitAtBreaks(tokens: InlineToken[]): InlineToken[][] {
  const lines: InlineToken[][] = [[]];
  for (const tok of tokens) {
    const parts = tok.v.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) lines.push([]);
      if (parts[i].length > 0) lines[lines.length - 1].push({ ...tok, v: parts[i] });
    }
  }
  return lines;
}

/**
 * 解析围栏代码块信息串：marked v18 把整条 info 串放进 token.lang
 * （如 `ts src/main.ts`），这里拆回 lang + caption（caption 形如路径时记为 path）。
 */
function fenceMeta(lang: string | undefined): { lang: string; caption: string } {
  const info = (lang ?? "").trim();
  if (!info) return { lang: "", caption: "" };
  const sp = info.search(/\s/);
  if (sp === -1) return { lang: info, caption: "" };
  return { lang: info.slice(0, sp), caption: info.slice(sp + 1).trim() };
}

/** marked 的 code token 内容已去掉 EOF 尾换行；仅缩进式代码残留一行尾空，剥掉。 */
function codeLinesOf(t: Tokens.Code): string[] {
  if (t.text === "") return [];
  const lines = t.text.split("\n");
  if (t.codeBlockStyle === "indented" && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** marked list token → 模型 ListNode。 */
function toListNode(l: Tokens.List): ListNode {
  const node: ListNode = {
    ordered: l.ordered,
    // marked 无序列表的 start 记作 ""，模型层仅有序列表使用
    start: typeof l.start === "number" ? l.start : 1,
    items: [],
  };
  for (const item of l.items) {
    const inline: InlineToken[] = [];
    let children: ListNode | null = null;
    let pendingTask = "";
    let contentStarted = false;
    // 段落性内容段之间插软换行（渲染折成空格，保住词边界）；任务标记附着到首段
    const beginChunk = (): void => {
      if (contentStarted) inline.push({ t: "text", v: "\n" });
      contentStarted = true;
      if (pendingTask !== "") {
        inline.push({ t: "text", v: pendingTask });
        pendingTask = "";
      }
    };
    for (const sub of item.tokens) {
      switch (sub.type) {
        case "space":
          break;
        case "checkbox":
          // 任务列表标记不渲染原生 checkbox，降级为字面 [x] / [ ]
          pendingTask = sub.checked ? "[x] " : "[ ] ";
          break;
        case "paragraph":
          beginChunk();
          inline.push(...toModelTokens(sub.tokens ?? []));
          break;
        case "heading":
          beginChunk();
          inline.push(...toModelTokens(sub.tokens ?? []));
          break;
        case "text": {
          beginChunk();
          // 块级 text 通常内嵌行内 tokens；惰性延续行（如 `- a` 后的缩进续行）没有时
          // 重新走行内解析，保证标记仍生效
          inline.push(...toModelTokens(sub.tokens?.length ? sub.tokens : inlineTokensOf(sub.text)));
          break;
        }
        case "list": {
          const child = toListNode(sub as Tokens.List);
          if (children) children.items.push(...child.items);
          else children = child;
          break;
        }
        case "code":
          // 列表项内的围栏代码块：模型无块级插槽，保内容为文本
          beginChunk();
          inline.push({ t: "text", v: sub.text });
          break;
        case "html":
          beginChunk();
          inline.push({ t: "text", v: sub.text });
          break;
        default: {
          const raw = (sub as Token).raw ?? "";
          if (raw !== "") {
            beginChunk();
            inline.push({ t: "text", v: raw });
          }
        }
      }
    }
    if (item.task && pendingTask !== "") {
      // checkbox token 缺失的罕见路径：把遗留标记前置
      inline.unshift({ t: "text", v: pendingTask });
    }
    node.items.push({ inline, children });
  }
  return node;
}

/** 引用块：从 raw 逐行剥 `>` 前缀后按行内解析 —— 引用内块级标记保持字面（旧版同款语义）。 */
function quoteLinesOf(t: Tokens.Blockquote): InlineToken[][] {
  const rawLines = t.raw.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines: InlineToken[][] = [];
  for (const line of rawLines) {
    const stripped = line.replace(/^[ \t]*>[ \t]?/, "");
    lines.push(parseInline(stripped));
  }
  return lines.length > 0 ? lines : [[]];
}

/** 块级 raw HTML（<script>/<div>/注释等）：整体降级为字面段落行，模板转义后显示。 */
function linesFromHtmlBlock(t: Tokens.HTML): InlineToken[][] {
  const rawLines = t.text.replace(/\r\n/g, "\n").split("\n");
  if (rawLines[rawLines.length - 1] === "" && rawLines.length > 1) rawLines.pop();
  return rawLines.length > 0 ? rawLines.map(parseInline) : [[]];
}

function toBlock(t: Token): Block | undefined {
  switch (t.type) {
    case "space":
    case "def":
      // 空白与引用定义（[id]: url）不产块；定义只服务链接解析
      return undefined;
    case "heading": {
      const inner = t.tokens ?? [];
      return {
        type: "heading",
        level: Math.min(6, Math.max(1, t.depth)) as 1 | 2 | 3 | 4 | 5 | 6,
        inline: toModelTokens(inner),
      };
    }
    case "paragraph": {
      const lines = splitAtBreaks(toModelTokens(t.tokens ?? []));
      // 空内容兜底为一行空文本，避免模板渲染空 <p> 悬空留白
      return { type: "p", lines: lines.length > 0 ? lines : [[]] };
    }
    case "text": {
      // 段落被列表等截断后的惰性延续；无行内 tokens 时退化按文本处理
      const tokens = t.tokens?.length ? t.tokens : inlineTokensOf(t.text);
      const lines = splitAtBreaks(toModelTokens(tokens));
      return { type: "p", lines: lines.length > 0 ? lines : [[]] };
    }
    case "code": {
      const { lang, caption } = fenceMeta(t.lang);
      return { type: "code", lang, path: PATH_LABEL.test(caption) ? caption : undefined, codeLines: codeLinesOf(t as Tokens.Code) };
    }
    case "list":
      return { type: "list", ...toListNode(t as Tokens.List) };
    case "blockquote":
      return { type: "quote", lines: quoteLinesOf(t as Tokens.Blockquote) };
    case "table": {
      // Token 联合里混有松散的 Generic（索引签名 any），收窄后属性仍带 any，
      // 这里显式落到具体接口，保住 header/rows/align 的类型
      const table = t as Tokens.Table;
      return {
        type: "table",
        headers: table.header.map((cell) => toModelTokens(cell.tokens)),
        align: table.align,
        rows: table.rows.map((row) => row.map((cell) => toModelTokens(cell.tokens))),
      };
    }
    case "hr":
      return { type: "hr" };
    case "html":
      return { type: "p", lines: linesFromHtmlBlock(t as Tokens.HTML) };
    default:
      // 未知扩展块：不渲染，避免把未审计内容带进文档
      return undefined;
  }
}

/** 源文本 → Block[]。块级结构由 marked 词法器保证 CommonMark/GFM 语义。 */
export function parseBlocks(content: string): Block[] {
  const out: Block[] = [];
  for (const token of marked.lexer(content, LEX_OPTIONS)) {
    const block = toBlock(token);
    if (block) out.push(block);
  }
  return out;
}

/** 行内标记解析：code / bold / italic / strike / link 等，块级语法保持字面。 */
export function parseInline(text: string): InlineToken[] {
  return toModelTokens(inlineTokensOf(text));
}
