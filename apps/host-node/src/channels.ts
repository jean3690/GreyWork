/**
 * 聊天通道命令的共享实现：媒体收发（能力矩阵 / inbox / 出站降级）、
 * 扫码创建应用（dingtalk / feishu / qq 三条注册协议）、telegram 机器人链接、
 * 微信扫码登录（官方 SDK）与「正在输入」。
 *
 * 移植 crates/greywork-host/src/channels/（media/ + dingtalk/feishu/qq 的 register、
 * telegram 的 bot_link、wechat 的 login/typing）。与 Rust 的分工一致：
 * - 凭据 / device_code / bind_key 等敏感态只留在宿主（落盘 0600 或进程内存）；
 * - 能力检查与降级改写在唯一一处（渲染端只是「提前告知」，不是唯一防线）；
 * - 这几个扫码注册接口都没有公开文档，是厂商给自家客户端留的内部通道；协议若变更，
 *   这里以 errcode/retcode/解密失败的形式**显式报错**（不静默失败），界面退回手填凭证。
 *
 * 出站媒体的通道覆盖：全七件套按能力矩阵分发 —— wechat（官方 SDK）、telegram（Bot API）、
 * feishu（im/v1 images/files）、discord（multipart 附件）、qq（官方分片上传四步）真实落地；
 * wecom 的出站媒体挂在 WS 长连接发送端上（req_id 上传三步），Node 宿主已实现入站长连接、
 * 出站媒体暂未接线，故报「通道未连接」与 Rust 同款；dingtalk 出站无媒体通道，由能力矩阵
 * 在 prepareOutbound 一处拦截。
 */
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

import { getBot } from "./wechat-channel.js";
import { loadCredentials as loadTelegramCredentials } from "./channel-telegram.js";
import { loadChannelCredentials, saveChannelCredentials } from "./channel-credentials.js";
import type { WorkspaceAccess } from "./workspace-access.js";

/** 入站媒体字节上限（与 fs_read_media 对齐：真实视频普遍超过 20MB）。 */
const MAX_MEDIA_BYTES = 128 * 1024 * 1024;
/** inbox 孤儿文件的保留时长：渲染端崩溃后未取走的副本由 prune 兜底。 */
const INBOX_STALE_MS = 24 * 60 * 60 * 1000;
const INBOX_SUB_DIR = "inbox";
/** 媒体能力矩阵遍历顺序（也是渲染端兜底矩阵的依据）。 */
const MEDIA_CHANNELS = ["wechat", "dingtalk", "feishu", "telegram", "qq", "discord", "wecom"] as const;

export type MediaKind = "image" | "video" | "audio" | "file";

export interface ChannelMediaCapability {
  inbound: MediaKind[];
  outbound: MediaKind[];
}

/** 通道的媒体能力。**协议事实的单一事实来源**（Rust capability.rs 同表）。 */
export function capabilityOf(channel: string): ChannelMediaCapability {
  const caps = (inbound: MediaKind[], outbound: MediaKind[]): ChannelMediaCapability => ({ inbound, outbound });
  switch (channel) {
    // 双向收发图片 / 视频 / 文件；SDK 没有语音发送端点，音频降级为文件。
    case "wechat":
      return caps(["image", "video", "audio", "file"], ["image", "video", "file"]);
    // 全类别原生双向。
    case "telegram":
    case "discord":
      return caps(["image", "video", "audio", "file"], ["image", "video", "audio", "file"]);
    // 出站 media 需封面 image_key、audio 需 opus，原生只到图片与文件。
    case "feishu":
      return caps(["image", "video", "audio", "file"], ["image", "file"]);
    // 语音端点要 SILK 编码，原生只到图片与视频。
    case "qq":
      return caps(["image", "video", "audio", "file"], ["image", "video", "file"]);
    // 被动回复只能把图片塞进 stream 图文混排，没有文件出口。
    case "wecom":
      return caps(["image", "video", "file"], ["image"]);
    // sessionWebhook 只认 text/markdown/link/actionCard/feedCard，出站没有任何媒体通道。
    case "dingtalk":
      return caps(["image", "video", "audio", "file"], []);
    default:
      return caps([], []);
  }
}

/** 该能力下这种媒体能不能出站：原生支持，或能降级为文件发。 */
export function capabilityAllows(cap: ChannelMediaCapability, kind: MediaKind): boolean {
  if (cap.outbound.includes(kind)) return true;
  return kind !== "file" && cap.outbound.includes("file");
}

/** 出站类别 → 实际下发给通道的类别：能力不允许返回 null，非原生但可降级的改写为 file。 */
export function effectiveKind(cap: ChannelMediaCapability, kind: MediaKind): MediaKind | null {
  if (!capabilityAllows(cap, kind)) return null;
  return cap.outbound.includes(kind) ? kind : "file";
}

/** 各通道的媒体能力矩阵；渲染端启动时拉一次。 */
export function channelMediaCapabilities(): Record<string, ChannelMediaCapability> {
  const out: Record<string, ChannelMediaCapability> = {};
  for (const channel of MEDIA_CHANNELS) out[channel] = capabilityOf(channel);
  return out;
}

/* ===== 魔数嗅探 / 命名（naming.rs 移植） ===== */

function startsWithBytes(bytes: Buffer, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** 按魔数嗅探图片：(mime, 扩展名)。认不出返回 null。 */
export function sniffImage(bytes: Buffer): [string, string] | null {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ["image/png", "png"];
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return ["image/jpeg", "jpg"];
  if (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")
    return ["image/gif", "gif"];
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP")
    return ["image/webp", "webp"];
  if (bytes.subarray(0, 2).toString("latin1") === "BM") return ["image/bmp", "bmp"];
  return null;
}

/** 按魔数嗅探视频容器：只认容器，不校验编码。 */
export function sniffVideo(bytes: Buffer): [string, string] | null {
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("latin1");
    // M4A 是纯音频品牌：不当作视频（交给 sniffAudio）。
    if (brand.startsWith("M4A")) return null;
    return brand === "qt  " ? ["video/quicktime", "mov"] : ["video/mp4", "mp4"];
  }
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return ["video/webm", "webm"];
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "AVI ")
    return ["video/x-msvideo", "avi"];
  if (startsWithBytes(bytes, [0x00, 0x00, 0x01, 0xba]) || startsWithBytes(bytes, [0x00, 0x00, 0x01, 0xb3])) return ["video/mpeg", "mpg"];
  return null;
}

/** 按魔数嗅探音频。 */
export function sniffAudio(bytes: Buffer): [string, string] | null {
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp" && bytes.subarray(8, 10).toString("latin1") === "M4A")
    return ["audio/mp4", "m4a"];
  if (bytes.subarray(0, 4).toString("latin1") === "OggS") return ["audio/ogg", "ogg"];
  if (
    bytes.subarray(0, 3).toString("latin1") === "ID3" ||
    startsWithBytes(bytes, [0xff, 0xfb]) ||
    startsWithBytes(bytes, [0xff, 0xf3]) ||
    startsWithBytes(bytes, [0xff, 0xf2])
  )
    return ["audio/mpeg", "mp3"];
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WAVE")
    return ["audio/wav", "wav"];
  if (bytes.subarray(0, 4).toString("latin1") === "fLaC") return ["audio/flac", "flac"];
  if (bytes.subarray(0, 5).toString("latin1") === "#!AMR") return ["audio/amr", "amr"];
  if (bytes.subarray(0, 6).toString("latin1") === "#!SILK") return ["audio/silk", "silk"];
  return null;
}

/** 文件名末段扩展名：小写、只保留字母数字、≤8 字符；不合格返回空串。 */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const raw = dot >= 0 ? name.slice(dot + 1) : "";
  const cleaned = [...raw]
    .filter((ch) => /[A-Za-z0-9]/.test(ch))
    .slice(0, 8)
    .join("")
    .toLowerCase();
  return cleaned;
}

/** 展示名净化：去掉控制字符，路径分隔符换成下划线，限长。不参与落盘路径。 */
export function sanitizeDisplayName(raw: string): string {
  const cleaned = [...raw]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .map((ch) => (ch === "/" || ch === "\\" || ch === ":" ? "_" : ch))
    .join("");
  const trimmed = cleaned
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  if (trimmed === "") return "attachment";
  return [...trimmed].slice(0, 120).join("");
}

/** 给展示名补上扩展名；已有同一后缀（大小写不敏感）则不重复追加。 */
function withExt(display: string, ext: string): string {
  const suffix = "." + ext;
  return display.toLowerCase().endsWith(suffix) ? display : display + suffix;
}

/** 定下 (展示名, mime, 落盘扩展名)：图片 / 视频 / 音频按魔数校正，文件沿用原扩展名。 */
export function finalizeMedia(kind: MediaKind, name: string, bytes: Buffer): [string, string, string] {
  const display = sanitizeDisplayName(name);
  if (kind === "image") {
    const [mime, ext] = sniffImage(bytes) ?? ["image/png", "png"];
    return [display + "." + ext, mime, ext];
  }
  if (kind === "video" || kind === "audio") {
    const sniffed = kind === "video" ? sniffVideo(bytes) : sniffAudio(bytes);
    if (sniffed !== null) {
      const [mime, ext] = sniffed;
      return [withExt(display, ext), mime, ext];
    }
    // 嗅不出：退回原扩展名；仍没有就按类别的通用后缀兜底。
    let ext = extOf(display);
    if (ext === "") ext = kind === "video" ? "mp4" : "mp3";
    return [withExt(display, ext), kind + "/" + ext, ext];
  }
  // 文件 mime 交给渲染端按扩展名推断，宿主不猜。
  return [display, "", extOf(display)];
}

/** inbox 落盘文件名：<收到时刻>-<序号>.<ext>。刻意不用对端给的文件名 —— 那是不可信输入。 */
export function inboxFileName(receivedAt: number, index: number, ext: string): string {
  return receivedAt + "-" + index + "." + (ext === "" ? "bin" : ext);
}

/** 显式类别字符串 → 类别；空 / 未知返回 null。voice 是 audio 的别名。 */
export function explicitKind(raw: string | null | undefined): MediaKind | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "voice") return "audio";
  if (value === "image" || value === "video" || value === "audio" || value === "file") return value;
  return null;
}

/* ===== inbox：入站落盘 / 取走 ===== */

/** 入站媒体收件目录（不存在则创建）：<dataDir>/<channel>/inbox/。 */
export function inboxDir(dataDir: string, channel: string): string {
  const dir = path.join(dataDir, channel, INBOX_SUB_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 清理收件目录里的孤儿文件（渲染端崩溃 / 未取走）。all=true 整目录清空。best-effort。 */
export function pruneInbox(dataDir: string, channel: string, all: boolean): void {
  let dir: string;
  try {
    dir = inboxDir(dataDir, channel);
  } catch {
    return;
  }
  if (all) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      const stale = Date.now() - statSync(path.join(dir, entry)).mtimeMs > INBOX_STALE_MS;
      if (stale) unlinkSync(path.join(dir, entry));
    } catch {
      // 单个失败不影响其它。
    }
  }
}

/** 把已取到明文的媒体字节落进 inbox 并产出描述。 */
export function storeInboundMedia(
  inbox: string,
  channel: string,
  receivedAt: number,
  index: number,
  kind: MediaKind,
  name: string,
  bytes: Buffer,
): { kind: string; name: string; mime: string; size: number; path: string } | null {
  const [displayName, mime, ext] = finalizeMedia(kind, name, bytes);
  const target = path.join(inbox, inboxFileName(receivedAt, index, ext));
  try {
    writePrivate(target, bytes);
  } catch (error) {
    console.warn("[" + channel + "] 入站媒体落盘失败: " + (error as Error).message);
    return null;
  }
  return { kind, name: displayName, mime, size: bytes.length, path: target };
}

/** 写私有文件：unix 下收紧到 0600。 */
function writePrivate(target: string, contents: Buffer): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const fd = openSync(target, "w", 0o600);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

/**
 * 取走一条入站媒体：校验路径落在收件目录内 → 读原始字节 → 删除文件。
 * 「取走即删」让收件目录不会堆积；删除失败不致命（下次 connect 的 pruneInbox 兜底）。
 */
export function channelTakeMedia(dataDir: string, channel: string, rawPath: string): Buffer {
  const inbox = inboxDir(dataDir, channel);
  let canonical: string;
  let canonicalInbox: string;
  try {
    canonical = path.resolve(rawPath);
    canonicalInbox = path.resolve(inbox);
  } catch (error) {
    throw new Error("媒体路径不可访问: " + (error as Error).message, { cause: error });
  }
  if (canonical !== canonicalInbox && !canonical.startsWith(canonicalInbox + path.sep)) {
    throw new Error("媒体路径不在收件目录内");
  }
  let stat;
  try {
    stat = statSync(canonical);
  } catch (error) {
    throw new Error("读取媒体元数据失败: " + (error as Error).message, { cause: error });
  }
  if (!stat.isFile()) throw new Error("媒体路径不是文件");
  if (stat.size > MAX_MEDIA_BYTES) throw new Error("媒体超过 " + MAX_MEDIA_BYTES + " 字节上限");
  let bytes: Buffer;
  try {
    bytes = readFileSync(canonical);
  } catch (error) {
    throw new Error("读取媒体失败: " + (error as Error).message, { cause: error });
  }
  try {
    unlinkSync(canonical);
  } catch (error) {
    console.warn("[" + channel + "] 删除收件媒体失败: " + (error as Error).message);
  }
  return bytes;
}

/* ===== 出站媒体：授权校验、读取与降级改写（outbound.rs 移植） ===== */

export interface OutboundMedia {
  bytes: Buffer;
  /** 文件名（各通道上传时用；也是日志里的标识）。 */
  name: string;
  kind: MediaKind;
}

function kindLabel(kind: MediaKind): string {
  switch (kind) {
    case "image":
      return "图片";
    case "video":
      return "视频";
    case "audio":
      return "语音";
    case "file":
      return "文件";
  }
}

/** 能力不允许时的说明文案（宿主侧兜底；渲染端另有一份 i18n 提示）。 */
function capabilityError(channel: string, cap: ChannelMediaCapability, kind: MediaKind): string {
  if (cap.outbound.length === 0) {
    return cap.inbound.length === 0 ? channel + " 不支持发送文件" : channel + " 只能接收消息，无法向外发送";
  }
  return channel + " 不支持发送" + kindLabel(kind);
}

/**
 * 发一条媒体前的公共准备：过授权面 → 卡能力 → 降级改写。
 * 能力检查放在唯一一处；返回的 OutboundMedia 已按能力改写完毕。
 */
export function prepareOutbound(access: WorkspaceAccess, channel: string, rawPath: string, kind: string | null): OutboundMedia {
  const cap = capabilityOf(channel);
  // 授权面与 fs_read_binary 同一套：渲染端选过的文件、~/.greyWork 下的附件都在其中。
  const real = access.resolveExisting(rawPath);
  let stat;
  try {
    stat = statSync(real);
  } catch (error) {
    throw new Error("读取文件元数据失败: " + (error as Error).message, { cause: error });
  }
  if (!stat.isFile()) throw new Error("只能发送文件");
  if (stat.size > MAX_MEDIA_BYTES) {
    throw new Error("文件超过 " + MAX_MEDIA_BYTES / (1024 * 1024) + " MB 上限");
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(real);
  } catch (error) {
    throw new Error("读取文件失败: " + (error as Error).message, { cause: error });
  }
  const name = path.basename(real) || "attachment";
  const media: OutboundMedia = { bytes, name, kind: resolveMediaKindNamed(null, name, bytes) };
  if (kind !== null) media.kind = resolveMediaKindNamed(kind, media.name, media.bytes);
  const effective = effectiveKind(cap, media.kind);
  if (effective === null) throw new Error(capabilityError(channel, cap, media.kind));
  // 原生端点做不到、但这条通道能发文件：降级为文件发。集中在这一处。
  if (effective !== media.kind) {
    console.log("[" + channel + "] 无原生" + kindLabel(media.kind) + "端点，降级为文件发送: " + media.name);
    media.kind = effective;
  }
  return media;
}

/** 类别判定：显式类别优先；否则按扩展名 + 魔数判。 */
function resolveMediaKindNamed(explicit: string | null, name: string, bytes: Buffer): MediaKind {
  const direct = explicitKind(explicit);
  if (direct !== null) return direct;
  const ext = extOf(name);
  if (sniffImage(bytes) !== null || ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image";
  if (sniffVideo(bytes) !== null || ["mp4", "mov", "webm", "mkv", "avi", "mpg"].includes(ext)) return "video";
  if (sniffAudio(bytes) !== null || ["mp3", "m4a", "wav", "ogg", "flac", "amr", "silk"].includes(ext)) return "audio";
  return "file";
}

/** 按通道名把媒体交给对应出口上传（dispatch.rs 移植）。 */
export async function sendMediaVia(
  dataDir: string,
  channel: string,
  peerId: string,
  _contextToken: string | null,
  media: OutboundMedia,
): Promise<void> {
  switch (channel) {
    case "wechat":
      await sendWechatMedia(dataDir, peerId, media);
      return;
    case "telegram":
      await sendTelegramMedia(dataDir, peerId, media);
      return;
    case "feishu":
      await sendFeishuMedia(dataDir, peerId, media);
      return;
    case "discord":
      await sendDiscordMedia(dataDir, peerId, media);
      return;
    case "qq":
      await sendQqMedia(dataDir, peerId, media);
      return;
    case "wecom":
      // 出站媒体要经长连接发送端（upload init/分片/finish + req_id 回执）；入站长连接
      // 已实现，出战媒体暂未接线，与 Rust「未连接」同款报错，界面退路相同。
      throw new Error("通道未连接：先连接企业微信通道再发送");
    default:
      throw new Error("未知通道: " + channel);
  }
}

/** 微信：交给 SDK 加密上传并发送（send() 内部按对端 context_token 复用）。 */
async function sendWechatMedia(dataDir: string, userId: string, media: OutboundMedia): Promise<void> {
  const bot = getBot(dataDir);
  switch (media.kind) {
    case "image":
      await bot.send(userId, { image: media.bytes });
      return;
    case "video":
      await bot.send(userId, { video: media.bytes });
      return;
    default:
      await bot.send(userId, { file: media.bytes, fileName: media.name });
  }
}

/** telegram：Bot API 按类别选端点（photo / video / voice / document）。 */
async function sendTelegramMedia(dataDir: string, chatId: string, media: OutboundMedia): Promise<void> {
  const creds = loadTelegramCredentials(dataDir);
  if (creds === null) throw new Error("Telegram bot token 未配置");
  const method =
    media.kind === "image" ? "sendPhoto" : media.kind === "video" ? "sendVideo" : media.kind === "audio" ? "sendVoice" : "sendDocument";
  const fieldName = media.kind === "image" ? "photo" : media.kind === "video" ? "video" : media.kind === "audio" ? "voice" : "document";
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append(fieldName, new Blob([new Uint8Array(media.bytes)]), media.name);
  let response: Response;
  try {
    response = await fetch("https://api.telegram.org/bot" + creds.botToken + "/" + method, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error("Telegram 上传失败（网络层）: " + (error as Error).message, { cause: error });
  }
  const text = await response.text();
  let parsed: { ok?: unknown; description?: unknown } = {};
  try {
    parsed = JSON.parse(text) as { ok?: unknown; description?: unknown };
  } catch {
    // 非 JSON 回包按 HTTP 状态处理。
  }
  if (parsed.ok !== true) {
    throw new Error(
      "Telegram 上传失败 (" + response.status + ")：" + (typeof parsed.description === "string" ? parsed.description : text.slice(0, 200)),
    );
  }
}

/* ===== telegram 机器人链接（bot_link 移植） ===== */

export interface TelegramBotLinkDto {
  url: string;
  name: string;
  username: string;
}

/** getMe → https://t.me/<username>（渲染端拿去生成二维码，把会话导到 bot）。 */
export async function telegramBotLink(dataDir: string): Promise<TelegramBotLinkDto> {
  const creds = loadTelegramCredentials(dataDir);
  if (creds === null) throw new Error("尚未配置 Telegram bot token");
  let response: Response;
  try {
    response = await fetch("https://api.telegram.org/bot" + creds.botToken + "/getMe", {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error("getMe 请求失败: " + (error as Error).message, { cause: error });
  }
  const body = await response.text();
  if (!response.ok) throw new Error("getMe 返回 " + response.status + ": " + body.slice(0, 200));
  let parsed: { ok?: unknown; result?: { username?: unknown; first_name?: unknown }; description?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch (error) {
    throw new Error("getMe 响应解析失败: " + (error as Error).message, { cause: error });
  }
  if (parsed.ok !== true) {
    throw new Error("Telegram 拒绝了 getMe：" + (typeof parsed.description === "string" ? parsed.description : "unknown error"));
  }
  const result = parsed.result;
  if (result === undefined || result === null) throw new Error("getMe 回包里没有机器人信息");
  const username = typeof result.username === "string" ? result.username.trim() : "";
  if (username === "") {
    throw new Error("该机器人没有 username：到 @BotFather 里用 /setname 设置用户名后才能生成扫码链接");
  }
  return { url: "https://t.me/" + username, name: typeof result.first_name === "string" ? result.first_name : "", username };
}

/* ===== 扫码创建应用：dingtalk（OAPI 内部通道） ===== */

const DINGTALK_REGISTRATION_BASE = "https://oapi.dingtalk.com";
const DINGTALK_SOURCE = "DING_DWS_CLAW";
const DINGTALK_DEFAULT_EXPIRE_IN = 7200;
const DINGTALK_DEFAULT_POLL_INTERVAL = 3;

interface RegisterSessionBase {
  expiresAt: number;
}

interface DingtalkSession extends RegisterSessionBase {
  deviceCode: string;
}

export interface RegisterStartDto {
  qrUrl: string;
  userCode?: string | null;
  expiresIn: number;
  interval: number;
}

export interface RegisterPollDto {
  state: string;
  detail: string | null;
}

async function postJson(url: string, body: unknown, action: string): Promise<{ status: number; text: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(action + "请求失败: " + (error as Error).message, { cause: error });
  }
  return { status: response.status, text: await response.text() };
}

/** OAPI 统一信封：errcode != 0 即失败。 */
function dingtalkEnvelope(text: string, status: number, action: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(action + "响应解析失败: " + (error as Error).message + "（HTTP " + status + ": " + text.slice(0, 120) + "）", {
      cause: error,
    });
  }
  const errcode = typeof parsed.errcode === "number" ? parsed.errcode : -1;
  if (errcode !== 0) {
    const detail = typeof parsed.errmsg === "string" ? parsed.errmsg.trim() : "";
    throw new Error(
      detail === "" ? action + "失败（errcode=" + errcode + "）" : action + "失败：" + detail + "（errcode=" + errcode + "）",
    );
  }
  return parsed;
}

function strField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function numField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && value > 0 ? value : null;
}

/** 扫码注册会话（device_code / bind_key 只在宿主内存）。 */
const registrationSessions = new Map<string, DingtalkSession | FeishuSession | QqSession>();

function takeSession<T extends RegisterSessionBase>(channel: string): T {
  const session = registrationSessions.get(channel);
  if (session === undefined) throw new Error("没有进行中的扫码创建流程");
  return session as unknown as T;
}

/** dingtalk_register_begin：先取 nonce，再换回 device_code（留宿主）与二维码链接。 */
export async function dingtalkRegisterBegin(): Promise<RegisterStartDto> {
  const base = DINGTALK_REGISTRATION_BASE;
  const init = dingtalkEnvelope(
    (await postJson(base + "/app/registration/init", { source: DINGTALK_SOURCE }, "发起扫码")).text,
    200,
    "发起扫码",
  );
  const nonce = strField(init, "nonce");
  if (nonce === "") throw new Error("扫码注册响应缺少 nonce");

  const begin = dingtalkEnvelope((await postJson(base + "/app/registration/begin", { nonce }, "发起扫码")).text, 200, "发起扫码");
  const deviceCode = strField(begin, "device_code");
  const qrUrl = strField(begin, "verification_uri_complete");
  if (deviceCode === "" || qrUrl === "") throw new Error("扫码注册响应缺少 device_code / 扫码链接");
  const expiresIn = numField(begin, "expires_in") ?? DINGTALK_DEFAULT_EXPIRE_IN;
  const interval = numField(begin, "interval") ?? DINGTALK_DEFAULT_POLL_INTERVAL;
  registrationSessions.set("dingtalk", { deviceCode, expiresAt: Date.now() + expiresIn * 1000 });
  return { qrUrl, userCode: strField(begin, "user_code") || null, expiresIn, interval };
}

/** dingtalk_register_poll：成功时凭证直接落盘，渲染端只需刷新状态。 */
export async function dingtalkRegisterPoll(dataDir: string): Promise<RegisterPollDto & { clientId: string | null }> {
  const session = takeSession<DingtalkSession>("dingtalk");
  const sameDevice = (): boolean => registrationSessions.get("dingtalk") === session;
  if (Date.now() >= session.expiresAt) {
    if (sameDevice()) registrationSessions.delete("dingtalk");
    return { state: "expired", detail: null, clientId: null };
  }
  const { status, text } = await postJson(
    DINGTALK_REGISTRATION_BASE + "/app/registration/poll",
    { device_code: session.deviceCode },
    "轮询扫码",
  );
  const body = dingtalkEnvelope(text, status, "轮询扫码");
  const clientId = strField(body, "client_id");
  const clientSecret = strField(body, "client_secret");
  // 先看凭证：SUCCESS 与凭证同时到达，按凭证判定比按 status 更稳。
  if (clientId !== "" && clientSecret !== "") {
    saveChannelCredentials(dataDir, "dingtalk", { clientId, clientSecret, savedAt: new Date().toISOString() });
    if (sameDevice()) registrationSessions.delete("dingtalk");
    return { state: "done", detail: null, clientId };
  }
  const reason = strField(body, "fail_reason");
  const statusText = strField(body, "status").toUpperCase();
  let state = "error";
  let detail: string | null = null;
  if (statusText === "WAITING") {
    state = "pending";
  } else if (statusText === "EXPIRED") {
    state = "expired";
    detail = reason || null;
  } else if (statusText === "FAIL") {
    state = "error";
    detail = reason || null;
  } else {
    detail = statusText === "" ? "服务端未返回状态" : "未知状态: " + statusText;
  }
  if (sameDevice()) {
    if (state === "pending") registrationSessions.set("dingtalk", session);
    else registrationSessions.delete("dingtalk");
  }
  return { state, detail, clientId: null };
}

/** dingtalk_register_cancel：作废本次 device_code，不再轮询。 */
export function dingtalkRegisterCancel(): void {
  registrationSessions.delete("dingtalk");
}

/* ===== 扫码创建应用：feishu（accounts.feishu.cn 表单协议） ===== */

const FEISHU_ACCOUNTS_DOMAIN = "https://accounts.feishu.cn";
const FEISHU_ACCOUNTS_LARK_DOMAIN = "https://accounts.larksuite.com";
const FEISHU_REGISTRATION_PATH = "/oauth/v1/app/registration";
const FEISHU_ARCHETYPE = "PersonalAgent";
const FEISHU_SOURCE = "greywork";
const FEISHU_DEFAULT_POLL_INTERVAL = 5;
const FEISHU_DEFAULT_EXPIRE_IN = 600;
const FEISHU_SLOW_DOWN_STEP = 5;

interface FeishuSession extends RegisterSessionBase {
  deviceCode: string;
  domain: string;
  intervalSecs: number;
  /** 是否已经因国际版租户切过域名（只切一次）。 */
  switched: boolean;
  /** 服务端要求的轮询间隔增量（slow_down 后变大，毫秒）。 */
  intervalMs: number | null;
}

async function postForm(url: string, pairs: [string, string][], action: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(pairs).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(action + "请求失败: " + (error as Error).message, { cause: error });
  }
  const body = await response.text();
  // 这个接口把「等待中」也表达成 HTTP 400 + JSON 体，所以状态码不能当失败判据。
  try {
    JSON.parse(body);
  } catch {
    throw new Error(action + "返回 HTTP " + response.status + ": " + body.slice(0, 120));
  }
  return body;
}

/** 二维码内容：在 verification_uri_complete 上补来源标记（官方 SDK 也这么做）。 */
function feishuQrUrl(verificationUriComplete: string): string {
  const url = new URL(verificationUriComplete);
  url.searchParams.set("from", "sdk");
  url.searchParams.set("tp", "sdk");
  url.searchParams.set("source", FEISHU_SOURCE);
  return url.toString();
}

/** feishu_register_begin：拿回 device_code（留宿主）与二维码链接。 */
export async function feishuRegisterBegin(): Promise<RegisterStartDto> {
  const body = await postForm(
    FEISHU_ACCOUNTS_DOMAIN + FEISHU_REGISTRATION_PATH,
    [
      ["action", "begin"],
      ["archetype", FEISHU_ARCHETYPE],
      ["auth_method", "client_secret"],
      ["request_user_info", "open_id"],
    ],
    "扫码注册",
  );
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    throw new Error("扫码注册响应解析失败: " + (error as Error).message, { cause: error });
  }
  const deviceCode = strField(parsed, "device_code");
  const verificationUri = strField(parsed, "verification_uri_complete");
  if (deviceCode === "" || verificationUri === "") throw new Error("扫码注册响应缺少 device_code / 扫码链接");
  const expiresIn = numField(parsed, "expires_in") ?? numField(parsed, "expire_in") ?? FEISHU_DEFAULT_EXPIRE_IN;
  const interval = numField(parsed, "interval") ?? FEISHU_DEFAULT_POLL_INTERVAL;
  registrationSessions.set("feishu", {
    deviceCode,
    domain: FEISHU_ACCOUNTS_DOMAIN,
    intervalSecs: interval,
    expiresAt: Date.now() + expiresIn * 1000,
    switched: false,
    intervalMs: null,
  });
  return { qrUrl: feishuQrUrl(verificationUri), userCode: strField(parsed, "user_code") || null, expiresIn, interval };
}

/** feishu_register_poll：pending 期间间隔由服务端给（slow_down 会变大）；国际版租户切域（只切一次）。 */
export async function feishuRegisterPoll(dataDir: string): Promise<RegisterPollDto & { appId: string | null; intervalMs: number | null }> {
  const session = takeSession<FeishuSession>("feishu");
  const sameDevice = (): boolean => registrationSessions.get("feishu") === session;
  if (Date.now() >= session.expiresAt) {
    if (sameDevice()) registrationSessions.delete("feishu");
    return { state: "expired", detail: null, appId: null, intervalMs: null };
  }
  const body = await postForm(
    session.domain + FEISHU_REGISTRATION_PATH,
    [
      ["action", "poll"],
      ["device_code", session.deviceCode],
    ],
    "扫码轮询",
  );
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    throw new Error("扫码轮询响应解析失败: " + (error as Error).message, { cause: error });
  }
  const described = (): string => {
    const detail = typeof parsed.error_description === "string" ? parsed.error_description.trim() : "";
    return detail;
  };
  const error = typeof parsed.error === "string" ? parsed.error : "";
  const appId = strField(parsed, "client_id");
  const appSecret = strField(parsed, "client_secret");
  const isLark = (parsed.user_info as Record<string, unknown> | undefined)?.tenant_brand === "lark";
  let state: string;
  let detail: string | null = null;
  let intervalMs: number | null = null;
  // 顺序与官方 SDK 一致：先看租户归属，再看凭证，最后看错误码。
  if (isLark && (appId === "" || appSecret === "")) {
    // 只切一次：切完还报 lark 就当普通等待，避免在两个域之间来回撞。
    if (session.switched) {
      state = "pending";
    } else {
      session.switched = true;
      session.domain = FEISHU_ACCOUNTS_LARK_DOMAIN;
      state = "pending";
    }
  } else if (appId !== "" && appSecret !== "") {
    saveChannelCredentials(dataDir, "feishu", { appId, appSecret, savedAt: new Date().toISOString() });
    if (sameDevice()) registrationSessions.delete("feishu");
    return { state: "done", detail: null, appId, intervalMs: null };
  } else if (error === "authorization_pending") {
    state = "pending";
  } else if (error === "slow_down") {
    session.intervalSecs += FEISHU_SLOW_DOWN_STEP;
    state = "pending";
  } else if (error === "access_denied") {
    state = "denied";
    detail = described();
  } else if (error === "expired_token" || error === "invalid_grant") {
    state = "expired";
    detail = described();
  } else if (error === "") {
    // 服务端没给错误码也没给凭证时继续等（与官方 SDK 一致，避免把瞬时状态当失败）。
    state = "pending";
  } else {
    state = "error";
    const fallback = described();
    detail = fallback === "" ? error : error + ": " + fallback;
  }
  if (state === "pending") intervalMs = session.intervalSecs * 1000;
  if (sameDevice()) {
    if (state === "pending") registrationSessions.set("feishu", session);
    else registrationSessions.delete("feishu");
  }
  return { state, detail, appId: null, intervalMs };
}

/** feishu_register_cancel：作废本次 device_code，不再轮询。 */
export function feishuRegisterCancel(): void {
  registrationSessions.delete("feishu");
}

/* ===== 扫码创建应用：qq（q.qq.com 绑定 + AES-256-GCM 解密） ===== */

const QQ_BIND_HOST = "https://q.qq.com";
const QQ_BIND_POLL_INTERVAL = 2;
const QQ_BIND_EXPIRE_IN = 300;

interface QqSession extends RegisterSessionBase {
  taskId: string;
  /** base64 编码的 AES-256 绑定密钥（32 字节随机，只留宿主内存）。 */
  bindKey: string;
}

/** 解密服务端下发的 AppSecret 密文：base64(12B nonce ‖ 密文 ‖ 16B GCM tag)。 */
export function decryptQqSecret(encrypted: string, bindKey: string): string {
  let keyBytes: Buffer;
  let raw: Buffer;
  try {
    keyBytes = Buffer.from(bindKey.trim(), "base64");
    raw = Buffer.from(encrypted.trim(), "base64");
  } catch {
    throw new Error("AppSecret 密文 base64 解码失败");
  }
  // 12B nonce + 至少 1B 密文 + 16B tag，少于这个长度就是密文格式不对。
  if (keyBytes.length !== 32 || raw.length <= 28) {
    throw new Error("AppSecret 密文格式异常");
  }
  const nonce = raw.subarray(0, 12);
  const ciphertextAndTag = raw.subarray(12);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce);
    decipher.setAuthTag(ciphertextAndTag.subarray(ciphertextAndTag.length - 16));
    plaintext = Buffer.concat([decipher.update(ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16)), decipher.final()]);
  } catch {
    throw new Error("AppSecret 解密失败");
  }
  const text = plaintext.toString("utf8");
  if (text === "") throw new Error("AppSecret 不是有效的 UTF-8");
  return text;
}

async function qqPostBind(payload: Record<string, unknown>, action: string): Promise<Record<string, unknown>> {
  const { status, text } = await postJson(
    QQ_BIND_HOST + (action === "发起扫码" ? "/lite/create_bind_task" : "/lite/poll_bind_result"),
    payload,
    action,
  );
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(action + "响应解析失败: " + (error as Error).message + "（HTTP " + status + ": " + text.slice(0, 120) + "）", {
      cause: error,
    });
  }
  const retcode = typeof parsed.retcode === "number" ? parsed.retcode : null;
  if (retcode !== null && retcode !== 0) {
    const detail = (typeof parsed.msg === "string" ? parsed.msg : typeof parsed.message === "string" ? parsed.message : "").trim();
    throw new Error(
      detail === "" ? action + "失败（retcode=" + retcode + "）" : action + "失败：" + detail + "（retcode=" + retcode + "）",
    );
  }
  const data = parsed.data;
  return data !== null && data !== undefined && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/** qq_register_begin：本地生成密钥 → 换回 task_id（留宿主）与二维码链接。 */
export async function qqRegisterBegin(): Promise<RegisterStartDto> {
  const bindKey = randomBytes(32).toString("base64");
  const data = await qqPostBind({ key: bindKey }, "发起扫码");
  const taskId = typeof data.task_id === "string" ? data.task_id.trim() : typeof data.task_id === "number" ? String(data.task_id) : "";
  if (taskId === "") throw new Error("扫码绑定响应缺少 task_id");
  registrationSessions.set("qq", { taskId, bindKey, expiresAt: Date.now() + QQ_BIND_EXPIRE_IN * 1000 });
  return {
    qrUrl: QQ_BIND_HOST + "/qqbot/openclaw/connect.html?task_id=" + encodeURIComponent(taskId) + "&_wv=2",
    userCode: null,
    expiresIn: QQ_BIND_EXPIRE_IN,
    interval: QQ_BIND_POLL_INTERVAL,
  };
}

/** qq_register_poll：成功时解密 AppSecret 并落盘，渲染端只需刷新状态。 */
export async function qqRegisterPoll(dataDir: string): Promise<RegisterPollDto & { appId: string | null }> {
  const session = takeSession<QqSession>("qq");
  const sameSession = (): boolean => registrationSessions.get("qq") === session;
  if (Date.now() >= session.expiresAt) {
    if (sameSession()) registrationSessions.delete("qq");
    return { state: "expired", detail: null, appId: null };
  }
  const data = await qqPostBind({ task_id: session.taskId }, "轮询扫码");
  const status = typeof data.status === "number" ? data.status : 0;
  if (status === 2) {
    const appId =
      typeof data.bot_appid === "string" ? data.bot_appid.trim() : typeof data.bot_appid === "number" ? String(data.bot_appid) : "";
    const encrypted = typeof data.bot_encrypt_secret === "string" ? data.bot_encrypt_secret.trim() : "";
    if (appId === "" || encrypted === "") throw new Error("扫码成功但未返回完整 QQ 机器人凭证");
    const appSecret = decryptQqSecret(encrypted, session.bindKey);
    saveChannelCredentials(dataDir, "qq", { appId, appSecret, savedAt: new Date().toISOString() });
    if (sameSession()) registrationSessions.delete("qq");
    return { state: "done", detail: null, appId };
  }
  if (status === 3) {
    if (sameSession()) registrationSessions.delete("qq");
    return { state: "expired", detail: null, appId: null };
  }
  // status 0/1：还没扫码 / 还没在手机上确认。
  return { state: "pending", detail: null, appId: null };
}

/** qq_register_cancel：作废本次绑定任务，不再轮询。 */
export function qqRegisterCancel(): void {
  registrationSessions.delete("qq");
}

/* ===== 微信扫码登录（官方 SDK）与「正在输入」 ===== */

/** 扫码登录的宿主侧状态镜像（Rust LoginRun 同构）。SDK 的登录是「后台跑 + 回调给码」。 */
interface WechatLoginRun {
  generation: number;
  /** 是否由 wechat_login_qr 显式发起（区别于 SDK 自行重登）。 */
  explicit: boolean;
  qr: string | null;
  /** 二维码已换新（旧码过期），前端据此刷新二维码。 */
  refreshed: boolean;
  outcome: { kind: "confirmed"; userId: string; botId: string } | { kind: "failed"; detail: string } | null;
}

/** wechat_login_qr 等首张码的超时。 */
const LOGIN_QR_TIMEOUT_MS = 30_000;
/** wechat_login_poll 一次调用的最长挂起（前端按长轮询使用）。 */
const LOGIN_POLL_HOLD_MS = 25_000;

const wechatLogin: WechatLoginRun = {
  generation: 0,
  explicit: false,
  qr: null,
  refreshed: false,
  outcome: null,
};

/** 登录下发的地址必须 https 且在 qq.com 域内（persist.rs::trusted_api_base 同口径）。 */
function trustedApiBase(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch (error) {
    throw new Error("登录下发的地址非法: " + (error as Error).message, { cause: error });
  }
  if (parsed.protocol !== "https:") throw new Error("登录下发的地址必须是 https：" + raw);
  const host = parsed.hostname;
  if (host !== "qq.com" && !host.endsWith(".qq.com")) {
    throw new Error("登录下发的主机不在 qq.com 域内：" + host);
  }
  return parsed.toString();
}

let loginTask: Promise<void> | null = null;

/** 后台跑 SDK 的 login：它阻塞到确认 / 放弃，宿主只把结果镜像进 wechatLogin。 */
function runLogin(dataDir: string): Promise<void> {
  const bot = getBot(dataDir);
  // force：显式扫码要求换新凭证；本地已有可用凭证时 SDK 自己会直接复用。
  const task = bot
    .login({
      force: false,
      callbacks: {
        onQrUrl: (url: string) => {
          wechatLogin.qr = url;
        },
        onExpired: () => {
          wechatLogin.refreshed = true;
        },
        // 配对码要用户在手机上读出来再填进本机，设置页没有这个输入面：交空串让服务端把这次扫码判掉。
        onVerifyCode: (isRetry: boolean) => {
          console.warn(
            "[wechat] " +
              (isRetry ? "服务端要求配对码，但当前界面没有输入入口，本次登录将失败" : "服务端要求配对码，但当前界面没有输入入口"),
          );
          return "";
        },
      },
    })
    .then((creds: { baseUrl: string; accountId: string; userId: string }) => {
      // 登录任务的收尾：校验登录地址 → 写回 LoginRun。
      try {
        trustedApiBase(creds.baseUrl);
        console.log("[wechat] 扫码登录成功 bot=" + creds.accountId);
        wechatLogin.outcome = { kind: "confirmed", userId: creds.userId, botId: creds.accountId };
      } catch (error) {
        // 地址不可信：绝不拿它发请求。
        console.warn("[wechat] 登录下发的地址不可信，已丢弃凭据: " + (error as Error).message);
        wechatLogin.outcome = { kind: "failed", detail: (error as Error).message };
      }
    })
    .catch((error: Error) => {
      console.warn("[wechat] 扫码登录失败: " + error.message);
      wechatLogin.outcome = { kind: "failed", detail: error.message };
    })
    .finally(() => {
      // 凭据可能刚落地：连接态由 runtime 管理，渲染端确认扫码后自己会去 connect。
      if (loginTask === task) loginTask = null;
    });
  return task;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 经函数读取：TS 的赋值收窄不跨函数边界（回调会在之后改写这些字段）。 */
function loginState(): WechatLoginRun {
  return wechatLogin;
}

/**
 * 申请登录二维码；返回要编码成二维码的链接文本。
 * SDK 的登录是「后台跑 + 回调给码」，这里等首张码就绪再返回，保持「调一次拿到码」的契约。
 */
export async function wechatLoginQr(dataDir: string): Promise<{ content: string }> {
  // 已有进行中的显式扫码：把那张码还回去，别起第二个登录任务。
  const inFlight = wechatLogin.explicit && wechatLogin.qr !== null && wechatLogin.outcome === null;
  if (inFlight) {
    return { content: wechatLogin.qr ?? "" };
  }
  wechatLogin.generation += 1;
  wechatLogin.explicit = true;
  wechatLogin.qr = null;
  wechatLogin.refreshed = false;
  wechatLogin.outcome = null;
  const generation = wechatLogin.generation;

  loginTask = runLogin(dataDir);

  const deadline = Date.now() + LOGIN_QR_TIMEOUT_MS;
  for (;;) {
    if (loginState().generation === generation) {
      const qr = loginState().qr;
      if (qr !== null) return { content: qr };
      const current = loginState().outcome;
      if (current !== null) {
        throw new Error(current.kind === "failed" ? current.detail : "该账号已登录（bot=" + current.botId + "），无需重新扫码");
      }
    }
    if (Date.now() >= deadline) throw new Error("等待二维码超时");
    await sleep(150);
  }
}

export interface WechatLoginPollDto {
  /** wait（还在等扫）/ expired（换码或失败，带新二维码内容或 detail）/ confirmed。 */
  status: string;
  qrContent: string | null;
  userId: string | null;
  botId: string | null;
  detail: string | null;
}

/** 轮询扫码结果；一次调用最多挂 LOGIN_POLL_HOLD（前端按长轮询使用）。 */
export async function wechatLoginPoll(): Promise<WechatLoginPollDto> {
  const generation = loginState().generation;
  const deadline = Date.now() + LOGIN_POLL_HOLD_MS;
  for (;;) {
    let result: WechatLoginPollDto | null = null;
    const state = loginState();
    if (state.generation !== generation || state.qr === null) {
      // 会话已被取消 / 被新的扫码取代：让前端的轮询循环干净收尾。
      result = { status: "expired", qrContent: null, userId: null, botId: null, detail: "本次扫码已结束" };
    } else if (state.outcome !== null) {
      const outcome = state.outcome;
      state.qr = null;
      state.explicit = false;
      result =
        outcome.kind === "confirmed"
          ? { status: "confirmed", qrContent: null, userId: outcome.userId, botId: outcome.botId, detail: null }
          : { status: "expired", qrContent: null, userId: null, botId: null, detail: outcome.detail };
    } else if (wechatLogin.refreshed) {
      wechatLogin.refreshed = false;
      result = { status: "expired", qrContent: wechatLogin.qr, userId: null, botId: null, detail: null };
    }
    if (result !== null) return result;
    if (Date.now() >= deadline) {
      return { status: "wait", qrContent: null, userId: null, botId: null, detail: null };
    }
    await sleep(150);
  }
}

/** 是否有进行中的扫码会话（WechatStatusDto.pendingLogin）。 */
export function wechatLoginPending(): boolean {
  return wechatLogin.explicit && wechatLogin.outcome === null;
}

/**
 * 取消进行中的扫码会话（关闭二维码视图时调用）。
 * SDK 的登录一旦开始就无法从外部中止，这里只作废宿主侧的会话与界面状态；
 * 若用户其实已经扫过码，服务端仍会确认，凭据会在下一次状态刷新时体现出来。
 */
export function wechatLoginCancel(): void {
  wechatLogin.generation += 1;
  wechatLogin.explicit = false;
  wechatLogin.qr = null;
  wechatLogin.refreshed = false;
  wechatLogin.outcome = null;
}

/**
 * 发送「正在输入」。
 * SDK 只提供「发一条正在输入」，没有取消接口，故 typing=false 是 no-op ——
 * 指示器由微信自己超时消失。
 */
export async function wechatSendTyping(dataDir: string, toUserId: string, typing: boolean): Promise<void> {
  if (!typing) return;
  const bot = getBot(dataDir);
  await bot.sendTyping(toUserId);
}

/* ===== 通道媒体上传：feishu / discord / qq（各通道 commands.rs 的 send_media 移植） ===== */

const FEISHU_DOMAIN = "https://open.feishu.cn";
const DISCORD_API = "https://discord.com/api/v10";
const QQ_API_BASE = "https://api.sgroup.qq.com";
/** QQ 业务类型：图片只认 png/jpg、视频只认 mp4/mov，其余一律按文件（4）发。 */
const QQ_FILE_TYPE_IMAGE = 1;
const QQ_FILE_TYPE_MEDIA = 2;
const QQ_FILE_TYPE_FILE = 4;

function briefBody(text: string): string {
  const trimmed = text.trim();
  const chars = [...trimmed];
  return chars.length <= 200 ? trimmed : chars.slice(0, 200).join("") + "…";
}

function feishuCheckCode(body: string, action: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    throw new Error(action + "响应解析失败: " + (error as Error).message, { cause: error });
  }
  const code = typeof parsed.code === "number" ? parsed.code : -1;
  if (code !== 0) {
    const message = typeof parsed.msg === "string" ? parsed.msg : "";
    throw new Error(action + "失败 code=" + code + " msg=" + message);
  }
  return parsed;
}

async function feishuToken(dataDir: string): Promise<string> {
  const creds = loadChannelCredentials(dataDir, "feishu") as { appId?: string; appSecret?: string } | null;
  if (!creds?.appId || !creds?.appSecret) throw new Error("尚未配置飞书应用凭证");
  const response = await fetch(FEISHU_DOMAIN + "/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    signal: AbortSignal.timeout(15_000),
  }).catch((error: Error) => {
    throw new Error("换取 token 失败: " + error.message);
  });
  const body = await response.text();
  if (!response.ok) throw new Error("换取 token HTTP " + response.status + ": " + briefBody(body));
  const parsed = feishuCheckCode(body, "换取 token");
  const token = parsed.tenant_access_token;
  if (typeof token !== "string" || token === "") throw new Error("token 响应缺少 tenant_access_token");
  return token;
}

function feishuDataField(parsed: Record<string, unknown>, key: string, action: string): string {
  const data = parsed.data as Record<string, unknown> | undefined;
  const value = typeof data?.[key] === "string" ? (data[key] as string) : "";
  if (value === "") throw new Error(action + "响应缺少 " + key);
  return value;
}

/** 飞书传图（im/v1/images）→ image_key。 */
async function feishuUploadImage(token: string, media: OutboundMedia): Promise<string> {
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", new Blob([new Uint8Array(media.bytes)]), media.name);
  const response = await fetch(FEISHU_DOMAIN + "/open-apis/im/v1/images", {
    method: "POST",
    headers: { authorization: "Bearer " + token },
    body: form,
    signal: AbortSignal.timeout(60_000),
  }).catch((error: Error) => {
    throw new Error("上传图片失败: " + error.message);
  });
  const body = await response.text();
  if (!response.ok) throw new Error("上传图片 HTTP " + response.status + ": " + briefBody(body));
  return feishuDataField(feishuCheckCode(body, "上传图片"), "image_key", "上传图片");
}

/** 飞书传文件（im/v1/files，file_type=stream）→ file_key。 */
async function feishuUploadFile(token: string, media: OutboundMedia): Promise<string> {
  const form = new FormData();
  form.append("file_type", "stream");
  form.append("file_name", media.name);
  form.append("file", new Blob([new Uint8Array(media.bytes)]), media.name);
  const response = await fetch(FEISHU_DOMAIN + "/open-apis/im/v1/files", {
    method: "POST",
    headers: { authorization: "Bearer " + token },
    body: form,
    signal: AbortSignal.timeout(60_000),
  }).catch((error: Error) => {
    throw new Error("上传文件失败: " + error.message);
  });
  const body = await response.text();
  if (!response.ok) throw new Error("上传文件 HTTP " + response.status + ": " + briefBody(body));
  return feishuDataField(feishuCheckCode(body, "上传文件"), "file_key", "上传文件");
}

/** 飞书：图片走 im/v1/images，其余降级文件走 im/v1/files，再发一条 media 消息。 */
async function sendFeishuMedia(dataDir: string, peerId: string, media: OutboundMedia): Promise<void> {
  const token = await feishuToken(dataDir);
  let msgType: string;
  let content: Record<string, string>;
  if (media.kind === "image") {
    const imageKey = await feishuUploadImage(token, media);
    msgType = "image";
    content = { image_key: imageKey };
  } else {
    // 视频 / 语音无原生出站端点（media 需封面、audio 需 opus），共享层已降级为文件。
    const fileKey = await feishuUploadFile(token, media);
    msgType = "file";
    content = { file_key: fileKey };
  }
  const response = await fetch(FEISHU_DOMAIN + "/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ receive_id: peerId, msg_type: msgType, content: JSON.stringify(content) }),
    signal: AbortSignal.timeout(15_000),
  }).catch((error: Error) => {
    throw new Error("发送消息失败: " + error.message);
  });
  const body = await response.text();
  if (!response.ok) throw new Error("发送失败 HTTP " + response.status + ": " + briefBody(body));
  feishuCheckCode(body, "发送");
}

/** discord：multipart 带 files[0]（payload_json 固定空对象，元信息都在表单里）。 */
async function sendDiscordMedia(dataDir: string, peerId: string, media: OutboundMedia): Promise<void> {
  const creds = loadChannelCredentials(dataDir, "discord") as { token?: string } | null;
  if (!creds?.token) throw new Error("Discord bot token 未配置");
  const form = new FormData();
  form.append("payload_json", "{}");
  form.append("files[0]", new Blob([new Uint8Array(media.bytes)]), media.name);
  const response = await fetch(DISCORD_API + "/channels/" + peerId + "/messages", {
    method: "POST",
    headers: { authorization: "Bot " + creds.token },
    body: form,
    signal: AbortSignal.timeout(60_000),
  }).catch((error: Error) => {
    throw new Error("发送媒体失败: " + error.message);
  });
  const body = await response.text();
  if (!response.ok) throw new Error("发送媒体返回 " + response.status + ": " + briefBody(body));
}

/** QQ 的 peer 形态：c2c:<openid> / group:<openid>；无前缀按单聊兜底（Node 旧版形态）。 */
function decodeQqPeer(peerId: string): { scope: "c2c" | "group"; openid: string } | null {
  const colon = peerId.indexOf(":");
  if (colon < 0) return peerId === "" ? null : { scope: "c2c", openid: peerId };
  const prefix = peerId.slice(0, colon);
  const openid = peerId.slice(colon + 1).trim();
  if (prefix !== "c2c" && prefix !== "group") return null;
  if (openid === "") return null;
  return { scope: prefix, openid };
}

function qqMd5(bytes: Buffer): string {
  return createHash("md5").update(bytes).digest("hex");
}

function qqSha1(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/** QQ 业务类型判定：图片只认 png/jpg、视频只认 mp4/mov，其余一律按文件（4）。 */
function qqFileType(media: OutboundMedia): number {
  if (media.kind === "image") {
    const sniffed = sniffImage(media.bytes);
    if (sniffed !== null && (sniffed[0] === "image/png" || sniffed[0] === "image/jpeg")) {
      return QQ_FILE_TYPE_IMAGE;
    }
  }
  if (media.kind === "video" && ["mp4", "mov"].includes(extOf(media.name))) {
    return QQ_FILE_TYPE_MEDIA;
  }
  return QQ_FILE_TYPE_FILE;
}

/** QQ 的业务错误也走 200 + code：只判 HTTP 状态会把「消息被拒」当成成功。 */
async function qqPostApi(token: string, url: string, body: unknown, action: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: "QQBot " + token, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((error: Error) => {
    throw new Error(action + "请求失败: " + error.message);
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(action + "返回 " + response.status + ": " + briefBody(text));
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const code = typeof parsed.code === "number" ? parsed.code : null;
  if (code !== null && code !== 0) {
    const message = typeof parsed.message === "string" ? parsed.message : "unknown error";
    throw new Error("QQ 拒绝了" + action + "（" + code + "）：" + message);
  }
  return parsed;
}

async function qqToken(dataDir: string): Promise<string> {
  const creds = loadChannelCredentials(dataDir, "qq") as { appId?: string; appSecret?: string } | null;
  if (!creds?.appId || !creds?.appSecret) throw new Error("尚未配置 QQ 机器人 AppID / AppSecret");
  const response = await fetch("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: creds.appId, clientSecret: creds.appSecret }),
    signal: AbortSignal.timeout(15_000),
  }).catch((error: Error) => {
    throw new Error("取 access_token 失败: " + error.message);
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new Error("access_token 响应缺少 access_token");
  }
  return body.access_token;
}

function qqSizeOf(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * 把一条本地媒体传到 QQ 并换回 file_info（富媒体消息必填）。
 * 官方分片上传四步：upload_prepare（带 md5/sha1/前 10MB md5）→ 每片 PUT 到预签名地址
 * → 每片 upload_part_finish → files 合并换 file_info。
 */
async function qqUploadRichMedia(token: string, peer: { scope: "c2c" | "group"; openid: string }, media: OutboundMedia): Promise<string> {
  if (media.bytes.length === 0) throw new Error("不能发送空文件");
  const base = (peer.scope === "c2c" ? QQ_API_BASE + "/v2/users/" : QQ_API_BASE + "/v2/groups/") + peer.openid;
  const fileType = qqFileType(media);
  const fileSize = media.bytes.length;
  const headLen = Math.min(fileSize, 10 * 1024 * 1024);
  const prepared = await qqPostApi(
    token,
    base + "/upload_prepare",
    {
      file_type: fileType,
      file_name: media.name,
      file_size: String(fileSize),
      md5: qqMd5(media.bytes),
      sha1: qqSha1(media.bytes),
      md5_10m: qqMd5(media.bytes.subarray(0, headLen)),
    },
    "申请上传",
  );
  const uploadId = typeof prepared.upload_id === "string" ? prepared.upload_id.trim() : "";
  if (uploadId === "") throw new Error("申请上传响应缺少 upload_id");
  const rawParts = Array.isArray(prepared.parts) ? prepared.parts : [];
  const parts = rawParts
    .map((part) => {
      const record = part as { index?: unknown; presigned_url?: unknown; block_size?: unknown };
      return {
        index: typeof record.index === "number" ? record.index : -1,
        presignedUrl: typeof record.presigned_url === "string" ? record.presigned_url : "",
        blockSize: record.block_size,
      };
    })
    .filter((part) => part.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (parts.length === 0) throw new Error("申请上传响应没有分片信息");

  let offset = 0;
  for (const part of parts) {
    // 按服务端下发的片大小切；最后一片可能更小，用 min 收口。
    const end = Math.min(offset + qqSizeOf(part.blockSize), fileSize);
    if (end <= offset) throw new Error("分片 " + part.index + " 大小异常");
    if (part.presignedUrl.trim() === "") throw new Error("分片预签名地址为空");
    const chunk = media.bytes.subarray(offset, end);
    const put = await fetch(part.presignedUrl, {
      method: "PUT",
      body: new Uint8Array(chunk),
      signal: AbortSignal.timeout(60_000),
    }).catch((error: Error) => {
      throw new Error("上传分片请求失败: " + error.message);
    });
    if (!put.ok) {
      const body = await put.text().catch(() => "");
      throw new Error("上传分片返回 " + put.status + ": " + briefBody(body));
    }
    await qqPostApi(
      token,
      base + "/upload_part_finish",
      {
        upload_id: uploadId,
        part_index: part.index,
        block_size: String(end - offset),
        md5: qqMd5(chunk),
      },
      "完成分片",
    );
    offset = end;
  }
  if (offset !== fileSize) throw new Error("分片上传未覆盖整个文件");

  const merged = await qqPostApi(
    token,
    base + "/files",
    {
      file_type: fileType,
      file_name: media.name,
      upload_id: uploadId,
      srv_send_msg: false,
    },
    "合并文件",
  );
  const fileInfo = typeof merged.file_info === "string" ? merged.file_info : "";
  if (fileInfo === "") throw new Error("合并文件响应缺少 file_info");
  return fileInfo;
}

/**
 * QQ：先分片上传换 file_info，再发 msg_type=7 富媒体消息。
 * 入站长连接已实现，但宿主尚未按对端保存入站 msg_id 簿，消息体仍带空 msg_id ——
 * 与既有 qq_send 的行为一致；带 5 分钟窗口的被动回复语义待 msg_id 簿补齐后接入。
 */
async function sendQqMedia(dataDir: string, peerId: string, media: OutboundMedia): Promise<void> {
  const peer = decodeQqPeer(peerId);
  if (peer === null) throw new Error("对端 id 无法解析: " + JSON.stringify(peerId));
  const token = await qqToken(dataDir);
  const fileInfo = await qqUploadRichMedia(token, peer, media);
  const messagesUrl = (peer.scope === "c2c" ? QQ_API_BASE + "/v2/users/" : QQ_API_BASE + "/v2/groups/") + peer.openid + "/messages";
  await qqPostApi(
    token,
    messagesUrl,
    {
      msg_type: 7,
      media: { file_info: fileInfo },
      msg_id: "",
      msg_seq: 1,
    },
    "发送媒体",
  );
}
