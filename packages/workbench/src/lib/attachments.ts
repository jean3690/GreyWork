/**
 * 附件（图片 / 文本文件）的纯逻辑：类型判定、限额校验、旧数据归一化、文本内联格式。
 *
 * 与 IO 分离的理由：限额与内联格式是发送链路的关键判定，必须在无 Tauri / 无 DOM 的
 * 单测里可验证。落盘、采集、剪贴板等副作用都在 `state/attachment-library.ts`。
 */
import { createIdFactory } from "@greywork/core";
import type { Attachment, AttachmentKind } from "../types";

export const ATTACHMENT_LIMITS = {
  /** 单条消息附件数上限。 */
  maxCount: 6,
  /** 桌面态单张图片上限（fs_read_binary / fs_write_binary 同为 20MB，这里更保守）。 */
  maxImageBytes: 10 * 1024 * 1024,
  /** 单个文本文件上限。 */
  maxTextBytes: 1024 * 1024,
  /** 单条消息附件总字节上限。 */
  maxTotalBytes: 16 * 1024 * 1024,
  /** 内联进 prompt 的字符上限（超出截断并标记）。 */
  maxInlineTextChars: 120_000,
  /** 浏览器态图片上限：附件内联进会话存档，受 localStorage 5MB 硬限约束，必须更严。 */
  maxBrowserImageBytes: 2 * 1024 * 1024,
} as const;

/** 浏览器态图片重编码的最长边（超过则等比缩放，控制内联体积）。 */
export const BROWSER_IMAGE_MAX_EDGE = 1568;

export const IMAGE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

/** 图片扩展名（文件选择器过滤器 + 拖放路径的 mime 推断）。 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"] as const;

/** 文本类扩展名（同上）。比工作区导入的白名单宽：这里只是「能不能作为文本内联」。 */
export const TEXT_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "json",
  "csv",
  "log",
  "ts",
  "tsx",
  "js",
  "jsx",
  "vue",
  "html",
  "htm",
  "css",
  "scss",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "yml",
  "yaml",
  "toml",
  "xml",
  "sh",
  "sql",
  "ini",
] as const;

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  log: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/plain",
  jsx: "text/plain",
  vue: "text/plain",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  scss: "text/plain",
  py: "text/plain",
  rs: "text/plain",
  go: "text/plain",
  java: "text/plain",
  kt: "text/plain",
  yml: "text/yaml",
  yaml: "text/yaml",
  toml: "text/plain",
  xml: "text/xml",
  sh: "text/plain",
  sql: "text/plain",
  ini: "text/plain",
};

const TEXT_EXT_SET: ReadonlySet<string> = new Set(TEXT_EXTENSIONS);

/** 附件 id 工厂：短且文件名安全（会拼进附件库文件名）。 */
export const nextAttachmentId = createIdFactory("att");

/** 文件名扩展名（小写、无点）；无扩展名返回空串。 */
export function extOf(name: string): string {
  const base = basename(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 路径末段（兼容 Windows 分隔符）。 */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 按扩展名推断 mime；未知返回 fallback（可空串）。 */
export function mimeForFile(name: string, fallback = ""): string {
  return EXT_TO_MIME[extOf(name)] ?? fallback;
}

/** 判定附件类别：mime 优先，扩展名兜底；两者都不认识 → null（不支持）。 */
export function attachmentKind(name: string, mime: string): AttachmentKind | null {
  const normalized = mime.trim().toLowerCase();
  if (IMAGE_MIMES.has(normalized)) return "image";
  if (normalized.startsWith("text/") || normalized === "application/json") return "text";
  const ext = extOf(name);
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  if (TEXT_EXT_SET.has(ext)) return "text";
  return null;
}

/** 采集期拒绝原因：i18n key + 插值参数（UI 自行翻译，模块不碰 i18n 实例）。 */
export interface AttachmentRejection {
  key: string;
  params: Record<string, string | number>;
}

/**
 * 校验一个候选附件是否可加入草稿。返回 null = 通过。
 *
 * 采集时校验而非发送时：体积/数量问题要在用户刚选完文件时就地说清，
 * 而不是等到发送才发现附件被悄悄丢掉。
 */
export function validateAttachment(
  meta: { name: string; mime: string; size: number },
  existing: readonly Attachment[],
  isDesktop: boolean,
): AttachmentRejection | null {
  const kind = attachmentKind(meta.name, meta.mime);
  if (!kind) return { key: "chat.attachUnsupported", params: { name: meta.name } };
  if (existing.length >= ATTACHMENT_LIMITS.maxCount) {
    return { key: "chat.attachTooMany", params: { max: ATTACHMENT_LIMITS.maxCount } };
  }
  const limit =
    kind === "image"
      ? isDesktop
        ? ATTACHMENT_LIMITS.maxImageBytes
        : ATTACHMENT_LIMITS.maxBrowserImageBytes
      : ATTACHMENT_LIMITS.maxTextBytes;
  if (meta.size > limit) {
    return { key: "chat.attachTooLarge", params: { name: meta.name, limit: formatBytes(limit) } };
  }
  const total = existing.reduce((sum, item) => sum + item.size, 0) + meta.size;
  if (total > ATTACHMENT_LIMITS.maxTotalBytes) {
    return { key: "chat.attachTotalTooLarge", params: { limit: formatBytes(ATTACHMENT_LIMITS.maxTotalBytes) } };
  }
  return null;
}

/** 构造一条附件记录（分配 id；只带调用方给出的字段）。 */
export function createAttachment(input: Omit<Attachment, "id">): Attachment {
  return { id: nextAttachmentId(), ...input };
}

/**
 * 归一化历史数据里的 attachments。
 *
 * 旧版本该字段是 `string[]`（且从未被真实写入非空值），无法还原成文件，
 * 直接丢弃；畸形对象同理。返回的数组保证每条都具备渲染与发送所需的最小字段。
 */
export function normalizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<Attachment>;
    if (candidate.kind !== "image" && candidate.kind !== "text") continue;
    if (typeof candidate.id !== "string" || typeof candidate.name !== "string") continue;
    const hasBody = typeof candidate.path === "string" || typeof candidate.dataUrl === "string" || typeof candidate.text === "string";
    if (!hasBody) continue;
    out.push({
      id: candidate.id,
      kind: candidate.kind,
      name: candidate.name,
      mime: typeof candidate.mime === "string" ? candidate.mime : "",
      size: typeof candidate.size === "number" && Number.isFinite(candidate.size) ? candidate.size : 0,
      ...(typeof candidate.path === "string" ? { path: candidate.path } : {}),
      ...(typeof candidate.dataUrl === "string" ? { dataUrl: candidate.dataUrl } : {}),
      ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
      ...(candidate.truncated === true ? { truncated: true } : {}),
    });
  }
  return out;
}

/** 按字符数截断文本（内联与浏览器态存储共用）。 */
export function clipText(text: string, maxChars: number = ATTACHMENT_LIMITS.maxInlineTextChars): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** 计算不与内容冲突的围栏：内容里最长反引号串 + 1，至少 3 个。 */
export function textFence(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** 文本附件的内联格式（LLM 与 ACP 共用同一份，保证两条链路的模型看到一致结构）。 */
export function inlineTextAttachment(name: string, content: string, truncated: boolean): string {
  const fence = textFence(content);
  const body = truncated ? `${content}\n[...内容过长已截断]` : content;
  return `\n\n---\n[附件：${name}]\n${fence}\n${body}\n${fence}\n`;
}

/** 人类可读体积（附件 chip 与限额文案共用）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
