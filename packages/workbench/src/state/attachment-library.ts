/**
 * 附件库：采集（选择 / 拖放 / 粘贴）→ 落库（`~/.greyWork/attachments/<会话id>/`）→ 读取。
 *
 * 两阶段设计：
 * - **采集**只产生内存草稿（图片 dataUrl / 文本 text / 通用文件 bytes），输入卡据此
 *   立即出缩略图，此时选而不发不会在磁盘上留垃圾；
 * - **落库**（materialize）在发送时按会话目录写盘，并**剥离内联数据**只留 path ——
 *   会话是整条 ThreadMessage 落盘的，把 base64 留在消息里会撑爆 localStorage
 *   与会话 JSON 文件，路径化存储的意义也就没了。
 *
 * 浏览器态没有文件系统，只能保留内联副本（限额由 attachments.ts 单独收紧，
 * 通用文件在浏览器态直接不收）。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime, joinPath } from "@greywork/core";

import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import {
  ATTACHMENT_LIMITS,
  BROWSER_IMAGE_MAX_EDGE,
  IMAGE_EXTENSIONS,
  TEXT_EXTENSIONS,
  attachmentKind,
  basename,
  clipText,
  createAttachment,
  mimeForFile,
  validateAttachment,
  type AttachmentRejection,
} from "../lib/attachments";
import { i18n } from "../i18n";
import { notify } from "../stores/notice";
import type { Attachment } from "../types";
import { base64ToBytes, bytesToBase64, ensureDir, readBinaryFile, readTextFile, writeBinaryFile } from "./workspaceFiles";

const t = i18n.global.t;

/** 采集到的原始候选（尚未成为 Attachment 记录）。 */
interface Candidate {
  name: string;
  mime: string;
  size: number;
  bytes?: Uint8Array;
  text?: string;
}

/* ===== 附件库根目录 ===== */

let rootPromise: Promise<string | null> | null = null;

/** `~/.greyWork`（只解析一次；与 lib/artifact-dir.ts 同款缓存策略，互不共享）。 */
function defaultRoot(): Promise<string | null> {
  if (!isTauriRuntime()) return Promise.resolve(null);
  rootPromise ??= invoke<string>("store_default_root").catch(() => null);
  return rootPromise;
}

/** 会话附件目录（不存在则创建）；浏览器态或失败 → null。 */
export async function ensureAttachmentLibrary(sessionId: string): Promise<string | null> {
  if (!isTauriRuntime() || !sessionId) return null;
  const root = await defaultRoot();
  if (!root) return null;
  const dir = joinPath(root, "attachments", sessionId);
  try {
    await ensureDir(dir);
    return dir;
  } catch {
    return null;
  }
}

/**
 * 删除会话的附件目录（会话被删除时调用）。宿主侧只接受纯会话 id，
 * 且目录不存在按已删处理，所以这里可以放心「删了不存在的会话」也不报错。
 */
export async function pruneAttachmentLibrary(sessionId: string): Promise<void> {
  if (!isTauriRuntime() || !sessionId) return;
  try {
    await invoke("attachments_prune_session", { sessionId });
  } catch (error) {
    notify({
      kind: "warning",
      key: "attachment-prune",
      title: t("errors.attachmentPruneFailed"),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ===== 失败提示 ===== */

function notifyRejection(rejection: AttachmentRejection): void {
  notify({ kind: "warning", title: t(rejection.key, rejection.params), key: `attachment-reject-${rejection.key}` });
}

function notifyReadFailed(name: string, detail?: string): void {
  notify({ kind: "error", title: t("errors.attachmentReadFailed"), detail: detail ? `${name}：${detail}` : name, key: "attachment-read" });
}

/* ===== 候选 → 草稿 ===== */

function decodeUtf8(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 候选转附件草稿。浏览器态图片超限先降采样重编码（附件内联进会话存档，
 * 必须压住体积）；文本一律按内联上限截断 —— 桌面态落库写的也是这份截断文本，
 * 但发送时同样只发这一份，所以不改变模型看到的内容。
 */
async function toDraft(candidate: Candidate, isDesktop: boolean): Promise<Attachment | null> {
  const mime = candidate.mime || mimeForFile(candidate.name);
  const kind = attachmentKind(candidate.name, mime);
  if (!kind) return null;
  if (kind === "image") {
    let bytes = candidate.bytes;
    if (!bytes?.length) return null;
    if (!isDesktop && bytes.length > ATTACHMENT_LIMITS.maxBrowserImageBytes) {
      bytes = (await reencodeImage(bytes, mime)) ?? bytes;
    }
    return createAttachment({
      kind: "image",
      name: candidate.name,
      mime,
      size: bytes.length,
      dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`,
    });
  }
  if (kind === "file" || kind === "video" || kind === "audio") {
    // 通用文件 / 视频 / 语音只能落盘（浏览器态在 validateAttachment 已被拒），草稿必须带上
    // 原始字节，否则落库那一刻已经没有数据源了。
    const bytes = candidate.bytes;
    if (!isDesktop || !bytes?.length) return null;
    return createAttachment({ kind, name: candidate.name, mime, size: bytes.length, bytes });
  }
  const text = candidate.text ?? decodeUtf8(candidate.bytes);
  if (text == null) return null;
  const clipped = clipText(text);
  return createAttachment({
    kind: "text",
    name: candidate.name,
    mime,
    size: candidate.size || (candidate.bytes?.length ?? text.length),
    text: clipped.text,
    ...(clipped.truncated ? { truncated: true } : {}),
  });
}

/** 逐条草稿化并按限额过滤（超限即刻提示，不进入输入卡）。 */
async function accept(candidates: readonly Candidate[], existing: readonly Attachment[], isDesktop: boolean): Promise<Attachment[]> {
  const accepted: Attachment[] = [];
  for (const candidate of candidates) {
    const draft = await toDraft(candidate, isDesktop);
    if (!draft) {
      notifyRejection({ key: "chat.attachUnsupported", params: { name: candidate.name } });
      continue;
    }
    const rejection = validateAttachment({ name: draft.name, mime: draft.mime, size: draft.size }, [...existing, ...accepted], isDesktop);
    if (rejection) {
      notifyRejection(rejection);
      continue;
    }
    accepted.push(draft);
  }
  return accepted;
}

/* ===== 采集：文件选择 ===== */

/** 打开文件选择器（多选，图片 + 文本）。取消/失败 → 空数组。 */
export async function pickAttachments(existing: readonly Attachment[] = []): Promise<Attachment[]> {
  const isDesktop = isTauriRuntime();
  try {
    const candidates = isDesktop ? await candidatesFromDialog() : await candidatesFromInput();
    return await accept(candidates, existing, isDesktop);
  } catch (error) {
    notifyReadFailed(t("chat.attachPickerFailed"), error instanceof Error ? error.message : String(error));
    return [];
  }
}

async function candidatesFromDialog(): Promise<Candidate[]> {
  // purpose="media"：不限扩展名 —— 通用文件（PDF / 压缩包 / Office 文档）也要能选。
  const paths = await invoke<string[]>("fs_pick_files", { purpose: "media", multiple: true });
  return candidatesFromPaths(paths);
}

/** 浏览器态：临时 input[type=file]；取消（窗口重聚焦且未选）时归零，避免挂起的 Promise。 */
function candidatesFromInput(): Promise<Candidate[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = [...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS].map((ext) => `.${ext}`).join(",");
    let settled = false;
    const settle = (files: readonly File[]): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(files.length ? candidatesFromFiles(files) : []);
    };
    const onFocus = (): void => {
      setTimeout(() => settle([]), 300);
    };
    input.addEventListener("change", () => settle(Array.from(input.files ?? [])));
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

/* ===== 采集：路径 / File 对象 ===== */

/** 桌面拖放：路径已在磁盘上，直接读字节（≤20MB 通道）。 */
export async function attachmentsFromPaths(paths: readonly string[], existing: readonly Attachment[] = []): Promise<Attachment[]> {
  try {
    return await accept(await candidatesFromPaths(paths), existing, true);
  } catch (error) {
    notifyReadFailed(paths.join("、"), error instanceof Error ? error.message : String(error));
    return [];
  }
}

async function candidatesFromPaths(paths: readonly string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const path of paths) {
    const name = basename(path);
    const mime = mimeForFile(name);
    try {
      const bytes = await readBinaryFile(path);
      const text = attachmentKind(name, mime) === "text" ? (decodeUtf8(bytes) ?? undefined) : undefined;
      out.push({ name, mime, size: bytes.length, bytes, ...(text !== undefined ? { text } : {}) });
    } catch (error) {
      // 单个文件读失败（目录、超限、无权限）不该拖垮整次拖放。
      notifyReadFailed(name, error instanceof Error ? error.message : String(error));
    }
  }
  return out;
}

/** 浏览器拖放 / 粘贴：File 对象。 */
export async function attachmentsFromFiles(files: readonly File[], existing: readonly Attachment[] = []): Promise<Attachment[]> {
  try {
    return await accept(await candidatesFromFiles(files), existing, false);
  } catch (error) {
    notifyReadFailed(files.map((file) => file.name).join("、"), error instanceof Error ? error.message : String(error));
    return [];
  }
}

async function candidatesFromFiles(files: readonly File[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = file.type || mimeForFile(file.name);
      const text = attachmentKind(file.name, mime) === "text" ? (decodeUtf8(bytes) ?? undefined) : undefined;
      out.push({ name: file.name, mime, size: file.size, bytes, ...(text !== undefined ? { text } : {}) });
    } catch (error) {
      notifyReadFailed(file.name, error instanceof Error ? error.message : String(error));
    }
  }
  return out;
}

/* ===== 采集：剪贴板 ===== */

/**
 * 读剪贴板里的图片（桌面端专用）。
 *
 * WebKitGTK 下 HTML5 paste 事件拿不到剪贴板里的图片，必须走宿主插件；
 * 插件给的是 RGBA 原始像素，经 canvas 编码成 PNG —— 这样不用为「RGBA → PNG」
 * 单独引一个 Rust 图像编码依赖。
 */
export async function attachmentsFromClipboard(existing: readonly Attachment[] = []): Promise<Attachment[]> {
  if (!isTauriRuntime() || typeof document === "undefined") return [];
  let bytes: Uint8Array | null = null;
  try {
    const image = await readImage();
    const size = await image.size();
    const rgba = await image.rgba();
    bytes = await rgbaToPng(rgba, size.width, size.height);
  } catch {
    // 剪贴板里没有图片（或插件不可用）：静默——用户按 Ctrl+V 贴文本是常态。
    return [];
  }
  if (!bytes) return [];
  const name = `clipboard-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  return accept([{ name, mime: "image/png", size: bytes.length, bytes }], existing, true);
}

/* ===== 图片处理（浏览器态降采样 / 剪贴板 RGBA 编码共用） ===== */

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = url;
  });
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      void blob.arrayBuffer().then(
        (buffer) => resolve(new Uint8Array(buffer)),
        () => resolve(null),
      );
    }, "image/png");
  });
}

/** 等比缩放到最长边 BROWSER_IMAGE_MAX_EDGE 并重编码为 PNG；无法处理 → null（由调用方回落原图）。 */
async function reencodeImage(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime || "image/png" }));
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, BROWSER_IMAGE_MAX_EDGE / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasToPngBytes(canvas);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 剪贴板 RGBA 原始像素 → PNG 字节。 */
async function rgbaToPng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array | null> {
  if (!width || !height || rgba.length < width * height * 4) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4);
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvasToPngBytes(canvas);
}

/* ===== 落库 ===== */

/**
 * 把草稿写进会话附件库，返回**剥离内联数据**的记录（只留 path）。
 * 单条写失败不阻断其余：保留该条的内联数据降级，附件仍能发出去。
 */
export async function materializeAttachments(sessionId: string, items: readonly Attachment[]): Promise<Attachment[]> {
  if (!items.length) return [];
  const dir = await ensureAttachmentLibrary(sessionId);
  if (!dir) return items.map(stripTransient);
  const out: Attachment[] = [];
  for (const item of items) {
    if (item.path) {
      out.push(stripTransient(item));
      continue;
    }
    try {
      const bytes = await attachmentBytes(item);
      const ext = extOfName(item);
      const path = joinPath(dir, `${item.id}.${ext}`);
      await writeBinaryFile(path, bytes);
      out.push({ id: item.id, kind: item.kind, name: item.name, mime: item.mime, size: bytes.length, path });
    } catch (error) {
      notify({
        kind: "warning",
        title: t("errors.attachmentWriteFailed"),
        detail: error instanceof Error ? `${item.name}：${error.message}` : item.name,
        key: "attachment-write",
      });
      out.push(stripTransient(item));
    }
  }
  return out;
}

/**
 * 去掉仅草稿期存在的字段（`bytes`）。会话是整条 ThreadMessage 序列化落盘的，
 * `Uint8Array` 会退化成 `{"0":..,"1":..}` 的巨型对象。
 */
function stripTransient(item: Attachment): Attachment {
  if (!item.bytes) return item;
  const rest: Attachment = { ...item };
  delete rest.bytes;
  return rest;
}

function extOfName(item: Attachment): string {
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
  if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  if (item.kind === "image") return "png";
  if (item.kind === "text") return "txt";
  return "bin";
}

/* ===== 读取（发送与渲染共用） ===== */

function dataUrlPayload(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function attachmentBytes(item: Attachment): Promise<Uint8Array> {
  // 草稿期的原始字节优先：通用文件只在这一段存在数据（无 dataUrl / text），
  // 微信入站媒体也是先拿字节再落库，避免绕一圈 base64。
  if (item.bytes?.length) return item.bytes;
  if (item.path && isTauriRuntime()) return readBinaryFile(item.path);
  if (item.dataUrl) return base64ToBytes(dataUrlPayload(item.dataUrl));
  if (item.text != null) return new TextEncoder().encode(item.text);
  throw new Error(`附件「${item.name}」没有可读的数据源`);
}

export function readAttachmentBytes(item: Attachment): Promise<Uint8Array> {
  return attachmentBytes(item);
}

/** 图片附件 → base64（不含 data URL 前缀）。 */
export async function readAttachmentBase64(item: Attachment): Promise<string> {
  // 走 readBinaryFile 再在本地编码：fs_read_binary 现在回原始字节（预览那条高频路径
  // 因此省掉 base64 的 33% 膨胀与解码）。发图片是低频动作，这里多一次 JS 编码可接受。
  if (item.path && isTauriRuntime()) return bytesToBase64(await readBinaryFile(item.path));
  if (item.dataUrl) return dataUrlPayload(item.dataUrl);
  throw new Error(`附件「${item.name}」没有可读的图片数据`);
}

/** 文本附件 → 内容（统一按内联上限截断）。 */
export async function readAttachmentText(item: Attachment): Promise<{ text: string; truncated: boolean }> {
  if (item.text != null) return clipText(item.text);
  if (item.path && isTauriRuntime()) return clipText(await readTextFile(item.path));
  throw new Error(`附件「${item.name}」没有可读的文本内容`);
}

/* ===== 缩略图 URL 缓存 ===== */

/** path → objectURL。会话切换时整体释放；超过上限按插入顺序淘汰最旧的。 */
const urlCache = new Map<string, string>();
const URL_CACHE_LIMIT = 24;

/**
 * 渲染缩略图用的 URL：内联数据直接用，磁盘附件读字节转 blob URL 并进 LRU。
 * 读不到（文件被删/移走）返回 null，由调用方回落占位。
 */
export async function attachmentObjectUrl(item: Attachment): Promise<string | null> {
  if (item.dataUrl) return item.dataUrl;
  if (!item.path) return null;
  const cached = urlCache.get(item.path);
  if (cached) return cached;
  try {
    const bytes = await readAttachmentBytes(item);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: item.mime || "application/octet-stream" }));
    urlCache.set(item.path, url);
    if (urlCache.size > URL_CACHE_LIMIT) {
      const oldest = urlCache.keys().next().value;
      if (oldest !== undefined) {
        const stale = urlCache.get(oldest);
        if (stale) URL.revokeObjectURL(stale);
        urlCache.delete(oldest);
      }
    }
    return url;
  } catch {
    return null;
  }
}

/** 释放全部缩略图 URL（会话切换 / 组件卸载时调用，避免 blob 常驻内存）。 */
export function releaseAttachmentObjectUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}
