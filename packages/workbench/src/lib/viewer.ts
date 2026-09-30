/**
 * 产物查看器的类型分派与文件名工具（纯逻辑，便于单测）。
 *
 * 分派只看扩展名 —— 产物由本机管线写出，没有内容嗅探的必要，也没有 MIME 可用。
 * 未知扩展一律归 `raw`（CodeMirror 纯文本兜底），永远不会「打不开」。
 */

import { extname } from "@greywork/core";

export type ViewerKind =
  | "md"
  | "html"
  | "csv"
  | "code"
  | "xlsx"
  | "xls"
  | "docx"
  | "pptx"
  | "pdf"
  | "diff"
  | "image"
  | "video"
  | "3d"
  | "gis"
  | "web"
  | "raw"
  | "legacy-office";

const EXT_KIND: Record<string, ViewerKind> = {
  md: "md",
  markdown: "md",
  html: "html",
  htm: "html",
  csv: "csv",
  xlsx: "xlsx",
  // 老格式表格单独成类：宿主用 calamine 按内容嗅探解析（见 sheet.rs），
  // 与 doc/ppt 那些「真的读不了」的老格式不是一回事，混在一起就只能给占位提示。
  xls: "xls",
  xlt: "xls",
  docx: "docx",
  pptx: "pptx",
  pdf: "pdf",
  diff: "diff",
  patch: "diff",
  // 老格式（OLE2 复合文档）：现有解析器全部读不了 —— docx-parse / pptx-parse 读的是
  // OOXML 的 ZIP，Univer/exceljs 只认 xlsx。归到 legacy-office 明确提示，
  // 而不是落到 raw 被当文本读（二进制经 utf-8 解码就是满屏乱码，且不报错）。
  doc: "legacy-office",
  dot: "legacy-office",
  ppt: "legacy-office",
  pot: "legacy-office",
  pps: "legacy-office",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  svg: "image",
  // 视频：mp4 / webm 是浏览器原生支持的主力，mov / mkv 能否解出画面取决于宿主运行时的
  // 解码器（WebKitGTK 走 GStreamer 插件）。归到 video 而不是 raw —— 解不出来时给的是
  // 播放器错误 + 「用系统应用打开」，比把二进制当文本读出一屏乱码强得多。
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  mkv: "video",
  // 3D 模型：glb 是自包含的二进制容器，gltf 是 JSON（可能引用外部 .bin / 贴图，
  // 那种情况在 viewer 里明确报错而不是静默空白 —— 见 ModelViewer.vue）。
  glb: "3d",
  gltf: "3d",
  // GIS：geojson 是文本、shp 是二进制（同目录的 .dbf / .prj 会被顺带读取）。
  // **刻意不收 .json**：绝大多数 .json 是普通数据文件，归到 gis 会让它们失去代码视图。
  // 需要地图预览就把扩展名改成 .geojson。
  geojson: "gis",
  shp: "gis",
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
const BINARY_KINDS: ReadonlySet<ViewerKind> = new Set<ViewerKind>([
  "xlsx",
  "xls",
  "docx",
  "pptx",
  "pdf",
  "image",
  "video",
  "3d",
  "gis",
  "legacy-office",
]);

/**
 * 媒体 kind 向宿主申请的读取额度（字节）。
 *
 * 值按「这类文件实际有多大」给，而不是一律拉满 —— 视频动辄上百 MB，3D 模型通常几十 MB。
 * 宿主另有自己的硬顶（`MAX_MEDIA_BYTES`）并会夹紧，所以这里的数字只是申请值，
 * 真正的上限始终在宿主那一处。
 *
 * geojson / shp 不在表里：它们按整份字节读，走 `fs_read_binary` 的 20MB 通道 ——
 * 超过这个体量的矢量数据本来也不适合在预览面板里铺开。
 */
const MEDIA_LIMITS: Partial<Record<ViewerKind, number>> = {
  video: 128 * 1024 * 1024,
  "3d": 64 * 1024 * 1024,
};

/**
 * 该 kind 是否走媒体读取通道。
 *
 * 媒体走 `fs_read_media`（放宽上限）而不是 `fs_read_binary`（20MB 硬顶）——
 * 按 20MB 卡死等于真实视频一律打不开。分派只在这一处，与 `isBinaryKind` 同理。
 */
export function isMediaKind(kind: ViewerKind): boolean {
  return MEDIA_LIMITS[kind] !== undefined;
}

/** 该 kind 向宿主申请的读取额度；非媒体 kind 为 `undefined`（走 20MB 通道）。 */
export function mediaLimitOfKind(kind: ViewerKind): number | undefined {
  return MEDIA_LIMITS[kind];
}

/** 按扩展名推断产物查看类型；未知归 raw（文本兜底）。 */
export function kindOfPath(path: string): ViewerKind {
  const ext = extname(path).toLowerCase();
  return EXT_KIND[ext] ?? "raw";
}

/** 该 kind 是否必须走 readBinary。 */
export function isBinaryKind(kind: ViewerKind): boolean {
  return BINARY_KINDS.has(kind);
}

/**
 * 取路径末段文件名（兼容 Windows 分隔符）。
 *
 * 实现在 `@greywork/core`（与 `joinPath` / `normalizePath` 同一套分隔符规则）。
 * 这里保留同名重导出，`stores/preview.ts` / `SheetViewer.vue` / `attachment-library.ts`
 * 的既有 import 不必改。
 */
export { basename } from "@greywork/core";

/**
 * CodeMirror 语言扩展键。
 * 只返回 workbench 已安装的 lang 包能覆盖的值 —— 返回一个没装的语言名
 * 会让 TextViewer 走进动态 import 失败的分支，不如老实降级为纯文本（null）。
 * toml / shell 没有官方 lang 包，由 TextViewer 经 @codemirror/legacy-modes 桥接。
 */
export type CodeLanguage =
  | "javascript"
  | "json"
  | "markdown"
  | "html"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "cpp"
  | "css"
  | "sass"
  | "less"
  | "yaml"
  | "sql"
  | "xml"
  | "toml"
  | "shell"
  | "vue";

const EXT_LANGUAGE: Record<string, CodeLanguage> = {
  ts: "javascript",
  tsx: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  vue: "vue",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  css: "css",
  scss: "sass",
  sass: "sass",
  less: "less",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  xml: "xml",
  toml: "toml",
  sh: "shell",
  bash: "shell",
};

export function codeLanguageOfPath(path: string): CodeLanguage | null {
  const ext = extname(path).toLowerCase();
  return EXT_LANGUAGE[ext] ?? null;
}
