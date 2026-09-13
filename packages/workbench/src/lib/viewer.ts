/**
 * 产物查看器的类型分派与文件名工具（纯逻辑，便于单测）。
 *
 * 分派只看扩展名 —— 产物由本机管线写出，没有内容嗅探的必要，也没有 MIME 可用。
 * 未知扩展一律归 `raw`（CodeMirror 纯文本兜底），永远不会「打不开」。
 */

export type ViewerKind = "md" | "html" | "csv" | "code" | "xlsx" | "docx" | "pptx" | "pdf" | "diff" | "image" | "web" | "raw";

const EXT_KIND: Record<string, ViewerKind> = {
  md: "md",
  markdown: "md",
  html: "html",
  htm: "html",
  csv: "csv",
  xlsx: "xlsx",
  xls: "xlsx",
  docx: "docx",
  pptx: "pptx",
  pdf: "pdf",
  diff: "diff",
  patch: "diff",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  svg: "image",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  vue: "code",
  json: "code",
  yaml: "code",
  yml: "code",
  toml: "code",
  css: "code",
  scss: "code",
  py: "code",
  rs: "code",
  go: "code",
  java: "code",
  sh: "code",
  bash: "code",
  sql: "code",
  xml: "code",
};

/**
 * 必须按二进制读取的 kind。
 * 走错通道的代价不对称：二进制被当文本读会经 utf-8 解码后**不可逆地损坏**
 * （xlsx 读回即报「文件损坏」），所以这张表是白名单而非启发式判断。
 */
const BINARY_KINDS: ReadonlySet<ViewerKind> = new Set<ViewerKind>(["xlsx", "docx", "pptx", "pdf", "image"]);

/** 按扩展名推断产物查看类型；未知归 raw（文本兜底）。 */
export function kindOfPath(path: string): ViewerKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? "raw";
}

/** 该 kind 是否必须走 readBinary。 */
export function isBinaryKind(kind: ViewerKind): boolean {
  return BINARY_KINDS.has(kind);
}

/** 取路径末段文件名。 */
export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * CodeMirror 语言扩展键。
 * 只返回 workbench 已安装的四个 lang 包能覆盖的值 —— 返回一个没装的语言名
 * 会让 TextViewer 走进动态 import 失败的分支，不如老实降级为纯文本（null）。
 */
export type CodeLanguage = "javascript" | "json" | "markdown" | "html";

const EXT_LANGUAGE: Record<string, CodeLanguage> = {
  ts: "javascript",
  tsx: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  vue: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
};

export function codeLanguageOfPath(path: string): CodeLanguage | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANGUAGE[ext] ?? null;
}
