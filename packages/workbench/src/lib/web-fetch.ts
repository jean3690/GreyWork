/**
 * 网页正文抓取与提取（纯逻辑，DOM 环境可测）。
 *
 * 分工：宿主（Rust `web_fetch`）只做安全取回 HTML 原文；正文提取在这里用 DOMParser 做，
 * 避免为一个低频功能往 Rust 侧加 HTML 解析依赖。抽出来的正文只作纯文本使用 ——
 * 既不 `v-html`，也不加载远端 HTML 里的任何资源或脚本。
 */
import { webFetchBackend } from "./web-fetch-backend";

export interface WebArticle {
  /** 归一化后的请求地址，也是缓存键与预览 tab 的 path。 */
  url: string;
  /** 跟随重定向后的最终地址。 */
  finalUrl: string;
  title: string;
  text: string;
}

/** 正文缓存：预览 store 不存内容，viewer 按 URL 回这里取。 */
const CACHE = new Map<string, WebArticle>();

/** 输入归一化：补 https:// 前缀，去首尾空白；空串返回空串。 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** 清空缓存（测试隔离用）。 */
export function clearWebArticleCache(): void {
  CACHE.clear();
}

export function getCachedArticle(url: string): WebArticle | undefined {
  return CACHE.get(normalizeUrl(url));
}

/** 参与正文选取/拼接的块级标签：块前块后补换行，保留段落。 */
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "MAIN",
  "HEADER",
  "FOOTER",
  "ASIDE",
  "LI",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "PRE",
  "FIGURE",
  "FIGCAPTION",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TR",
  "TABLE",
  "DL",
  "DD",
  "DT",
]);

/** 与正文无关、直接删掉的节点。 */
const STRIP_SELECTOR = "script,style,noscript,iframe,svg,canvas,form,button,template,head,nav,footer,aside";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function textLength(el: Element): number {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

/** 选正文根：article → main/[role=main] → 文本量最大的候选（同长取文档序在前者，保证确定性）。 */
function pickRoot(doc: Document): Element {
  const article = doc.querySelector("article");
  if (article && textLength(article) > 0) return article;
  const main = doc.querySelector("main, [role='main']");
  if (main && textLength(main) > 0) return main;
  const body = doc.body ?? doc.documentElement;
  // body 含全部文本、必然最大，把它排除在「最大块」竞争外，只当兜底：
  // 否则永远选中 body，等于没做内容定位。候选同长时取文档序靠后者（更具体、更深）。
  let best: Element | null = null;
  let bestLength = 0;
  for (const el of Array.from(body.querySelectorAll("div,section,article,main,td"))) {
    const length = textLength(el);
    if (length > 0 && length >= bestLength) {
      bestLength = length;
      best = el;
    }
  }
  return best ?? body;
}

/** 深度优先收集文本：块级元素前后补换行，`<br>` 换算行。 */
function collectText(node: Node, out: string[]): void {
  if (node.nodeType === TEXT_NODE) {
    out.push(node.textContent ?? "");
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;
  const el = node as Element;
  if (el.tagName === "BR") {
    out.push("\n");
    return;
  }
  const block = BLOCK_TAGS.has(el.tagName);
  if (block) out.push("\n");
  for (const child of Array.from(el.childNodes)) collectText(child, out);
  if (block) out.push("\n");
}

/**
 * 从 HTML 提取标题与正文纯文本。
 * 无 DOMParser（node 环境）时抛错 —— 该函数只应在 DOM 运行时调用。
 */
export function extractReadable(html: string, url: string): { title: string; text: string } {
  if (typeof DOMParser === "undefined") {
    throw new Error("web fetch extraction requires a DOM runtime (DOMParser)");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const metaTitle = doc.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim();
  const h1 = doc.querySelector("h1")?.textContent?.trim();
  const docTitle = doc.title?.trim();
  const title = metaTitle || h1 || docTitle || url;

  for (const el of Array.from(doc.querySelectorAll(STRIP_SELECTOR))) el.remove();
  const root = pickRoot(doc);
  const parts: string[] = [];
  collectText(root, parts);
  const text = parts
    .join("")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text };
}

/** 抓取一篇网页并提取正文；结果写入缓存供预览读取。 */
export async function fetchArticle(url: string): Promise<WebArticle> {
  const normalized = normalizeUrl(url);
  if (!normalized) throw new Error("web fetch: url is empty");
  const result = await webFetchBackend.fetch(normalized);
  const { title, text } = extractReadable(result.html, result.finalUrl);
  const article: WebArticle = {
    url: normalized,
    finalUrl: result.finalUrl,
    title: title || result.finalUrl,
    text,
  };
  CACHE.set(normalized, article);
  return article;
}
