/**
 * 七条消息通道的连接器：把各家长轮询 / WebSocket 协议收敛成统一的入站消息。
 *
 * 移植 `crates/greywork-host/src/channels/{telegram,discord,dingtalk,feishu,qq,wecom,wechat}/connect.rs`
 * 的连接主循环（含指数退避重连），Rust 侧每个通道的 `Inner` 状态改由 ChannelRuntime 统一持有。
 *
 * 协议要点：
 * - telegram：Bot API `getUpdates` 长轮询（支持自托管 Bot API 端点）；
 * - discord / qq：官方 Gateway（hello → identify/resume → 心跳 → dispatch）；
 * - dingtalk：Stream 反向 WS（先 POST 换 endpoint+ticket，帧需按 messageId 回执）；
 * - feishu：`/callback/ws/endpoint` 换 wss 地址，帧是 protobuf `pbbp2.Frame`；
 * - wecom：`aibot_subscribe` 订阅握手 + `ping` 心跳 + 回调分发；
 * - wechat：官方 `@wechatbot/wechatbot` SDK（login 载入本地凭证 → start 长轮询）。
 *
 * 入站媒体：telegram / wechat / discord / qq 提供直链或 SDK 下载能力，落进 inbox 后
 * 以 MediaRef 下发；dingtalk / feishu / wecom 的媒体要换 token / 解密，非文本正文按
 * 各自的 msgType 如实标为 unsupported（界面提示「只认文字」），不假装收到。
 */
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import { getBot } from "./wechat-channel.js";
import { loadChannelCredentials } from "./channel-credentials.js";
import { inboxDir, storeInboundMedia, type MediaKind } from "./channels.js";
import {
  asArray,
  asRecord,
  backoffMs,
  brief,
  httpJson,
  openWs,
  sleepOrStop,
  str,
  wsSend,
  WsQueue,
  type Connector,
  type ConnectorContext,
} from "./channel-common.js";

const MEDIA_CAP_BYTES = 128 * 1024 * 1024;
const MAX_INBOUND_MEDIA = 4;

/** 媒体类别：先按 mime，再按扩展名，最后按文件。 */
function mediaKind(mime: string | null, name: string): MediaKind {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "avi", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "flac", "ogg", "amr", "silk"].includes(ext)) return "audio";
  return "file";
}

/** 下载直链媒体并落 inbox；失败只记日志，不阻断文本入站。 */
async function downloadToInbox(
  ctx: ConnectorContext,
  url: string,
  at: number,
  index: number,
  kind: MediaKind,
  name: string,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MEDIA_CAP_BYTES) throw new Error("媒体超过大小上限");
    return storeInboundMedia(inboxDir(ctx.dataDir, ctx.channel), ctx.channel, at, index, kind, name, bytes);
  } catch (error) {
    console.warn(`[${ctx.channel}] 入站媒体下载失败: ${(error as Error).message}`);
    return null;
  }
}

async function materialize(
  ctx: ConnectorContext,
  at: number,
  pending: { url: string; kind: MediaKind; name: string; headers?: Record<string, string> }[],
): Promise<Record<string, unknown>[]> {
  const refs: Record<string, unknown>[] = [];
  for (const [index, item] of pending.slice(0, MAX_INBOUND_MEDIA).entries()) {
    const ref = await downloadToInbox(ctx, item.url, at, index, item.kind, item.name, item.headers);
    if (ref) refs.push(ref);
  }
  return refs;
}

/** 致命错误：不该重连（如被新连接接管），直接冒泡给 runtime 标 error。 */
class FatalError extends Error {}

/** 连上/断线/出错统一走这条循环：once() 阻塞到连接结束，异常按退避重连。 */
async function loop(ctx: ConnectorContext, label: string, once: () => Promise<void>): Promise<void> {
  let attempt = 0;
  while (!ctx.signal.aborted) {
    try {
      await once();
      attempt = 0;
    } catch (error) {
      // 主动断开会把 WS/fetch 打断成异常，但那不是故障：别把状态覆写成 error。
      if (ctx.signal.aborted) return;
      if (error instanceof FatalError) throw error;
      attempt += 1;
      ctx.runtime.markError(ctx.channel, `${label}失败: ${(error as Error).message}`);
      if (!(await sleepOrStop(ctx.signal, backoffMs(attempt)))) break;
      ctx.runtime.markConnecting(ctx.channel);
      continue;
    }
    if (!(await sleepOrStop(ctx.signal, backoffMs(attempt)))) break;
    ctx.runtime.markConnecting(ctx.channel);
  }
}

function parseFrame(raw: string | Buffer): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(String(raw)));
  } catch {
    return {};
  }
}

/** abort 时关 WS；返回清理函数（同时清心跳定时器）。 */
function bindWs(ctx: ConnectorContext, socket: WebSocket): () => void {
  const onAbort = () => socket.close();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    ctx.signal.removeEventListener("abort", onAbort);
    socket.close();
  };
}

/* ==================== Telegram ==================== */

/** 自托管 Bot API 服务器可经此环境变量指向本地（官方支持），同时给联调留了 mock 入口。 */
export const TELEGRAM_API_BASE = process.env.GREYWORK_TELEGRAM_API_BASE ?? "https://api.telegram.org";

export interface TelegramDraft {
  messageId: string;
  peerId: string;
  nick: string;
  text: string;
  media: { url: string; kind: MediaKind; name: string }[];
  at: number;
}

/** getUpdates 里的一条 message → 入站草稿（纯函数，便于单测）。 */
export function normalizeTelegramMessage(message: Record<string, unknown>, at: number): TelegramDraft | null {
  const chat = asRecord(message.chat);
  const chatId = chat.id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return null;
  const peerId = String(chatId);
  const from = asRecord(message.from);
  const nick = [str(from.first_name), str(from.last_name)].filter(Boolean).join(" ") || str(from.username) || peerId;
  const text = str(message.text) ?? str(message.caption) ?? "";
  const media: TelegramDraft["media"] = [];
  const push = (value: unknown, kind: MediaKind, name: string) => {
    const item = asRecord(value);
    const fileId = str(item.file_id);
    if (fileId) media.push({ url: `fileid:${fileId}`, kind, name });
  };
  const photos = asArray(message.photo);
  if (photos.length) push(photos[photos.length - 1], "image", "photo.jpg");
  push(message.document, "file", str(asRecord(message.document).file_name) ?? "file.bin");
  push(message.video, "video", str(asRecord(message.video).file_name) ?? "video.mp4");
  push(message.audio, "audio", str(asRecord(message.audio).file_name) ?? "audio.mp3");
  push(message.voice, "audio", "voice.ogg");
  if (!text.trim() && media.length === 0) return null;
  return { messageId: String(message.message_id ?? ""), peerId, nick, text, media, at };
}

const telegram: Connector = async (ctx) => {
  const credentials = loadChannelCredentials(ctx.dataDir, "telegram");
  const token = str(credentials?.token) ?? str(credentials?.botToken);
  if (!token) throw new Error("Telegram bot token 未配置");
  const apiBase = ctx.endpointOverride ?? TELEGRAM_API_BASE;
  const base = `${apiBase}/bot${token}`;
  let offset = 0;
  await loop(ctx, "长轮询", async () => {
    const response = await httpJson(
      `${base}/getUpdates?offset=${offset}&timeout=25&allowed_updates=${encodeURIComponent('["message"]')}`,
      {},
      40_000,
    );
    if (response.status !== 200 || response.body?.ok !== true) {
      throw new Error(`getUpdates 返回 ${response.status}: ${brief(response.text)}`);
    }
    ctx.runtime.markConnected("telegram");
    for (const raw of asArray(response.body.result)) {
      const update = asRecord(raw);
      const updateId = Number(update.update_id);
      if (Number.isFinite(updateId)) offset = Math.max(offset, updateId + 1);
      const at = Date.now();
      const draft = normalizeTelegramMessage(asRecord(update.message), at);
      if (!draft) continue;
      const pending = await resolveTelegramFiles(apiBase, token, draft.media);
      const media = await materialize(ctx, at, pending);
      ctx.runtime.emitInbound(
        "telegram",
        draft.peerId,
        draft.peerId,
        at,
        { messageId: draft.messageId, peerId: draft.peerId, nick: draft.nick, text: draft.text, media, at },
        ctx.allowOtherSenders,
      );
    }
  });
};

/** file_id → 可下载直链（getFile）。 */
async function resolveTelegramFiles(
  apiBase: string,
  token: string,
  media: TelegramDraft["media"],
): Promise<{ url: string; kind: MediaKind; name: string }[]> {
  const out: { url: string; kind: MediaKind; name: string }[] = [];
  for (const item of media.slice(0, MAX_INBOUND_MEDIA)) {
    const fileId = item.url.slice("fileid:".length);
    try {
      const response = await httpJson(`${apiBase}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
      const filePath = str(asRecord(response.body?.result).file_path);
      if (filePath) out.push({ ...item, url: `${apiBase}/file/bot${token}/${filePath}` });
    } catch (error) {
      console.warn(`[telegram] getFile 失败: ${(error as Error).message}`);
    }
  }
  return out;
}

/* ==================== Discord ==================== */

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_INTENTS_DIRECT_MESSAGES = 1 << 12;

function gatewayWsUrl(base: string): string {
  const [head, query] = base.split("?");
  const url = (head ?? base).replace(/\/+$/, "");
  const hasPath = url.replace(/^\w+:\/\/[^/]+/, "").replace(/^\//, "").length > 0;
  const prefix = `${hasPath ? url : `${url}/`}?v=10&encoding=json`;
  return query ? `${prefix}&${query}` : prefix;
}

export interface DiscordDraft {
  messageId: string;
  peerId: string;
  nick: string;
  senderId: string;
  text: string;
  media: { url: string; kind: MediaKind; name: string }[];
  at: number;
}

/** Discord MESSAGE_CREATE → 入站草稿（只放行私聊，忽略 bot 与服务器频道）。 */
export function normalizeDiscordMessage(data: Record<string, unknown>, at: number): DiscordDraft | null {
  const id = str(data.id);
  const channelId = str(data.channel_id);
  if (!id || !channelId || str(data.guild_id)) return null;
  const author = asRecord(data.author);
  if (author.bot === true) return null;
  const senderId = str(author.id);
  if (!senderId) return null;
  const nick = str(author.global_name) ?? str(author.username) ?? senderId;
  const text = str(data.content) ?? "";
  const media = asArray(data.attachments)
    .map((raw) => {
      const item = asRecord(raw);
      const url = str(item.url);
      if (!url) return null;
      const name = str(item.filename) ?? "attachment";
      return { url, kind: mediaKind(str(item.content_type), name), name };
    })
    .filter((item): item is { url: string; kind: MediaKind; name: string } => item !== null);
  const timestamp = str(data.timestamp);
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return {
    messageId: id,
    peerId: `dm:${channelId}`,
    nick,
    senderId,
    text,
    media,
    at: Number.isFinite(parsed) ? parsed : at,
  };
}

const discord: Connector = async (ctx) => {
  const credentials = loadChannelCredentials(ctx.dataDir, "discord");
  const token = str(credentials?.token);
  if (!token) throw new Error("Discord bot token 未配置");
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let lastSeq: number | null = null;
  await loop(ctx, "网关连接", async () => {
    let url = resumeUrl;
    if (!url) {
      const response = await httpJson(`${DISCORD_API}/gateway/bot`, { headers: { authorization: `Bot ${token}` } });
      const gateway = str(response.body?.url);
      if (!gateway) throw new Error(`取网关地址失败: ${brief(response.text)}`);
      url = gatewayWsUrl(gateway);
    } else {
      url = gatewayWsUrl(url);
    }
    const socket = await openWs(url, ctx.signal);
    const cleanup = bindWs(ctx, socket);
    const queue = new WsQueue(socket);
    let heartbeat: NodeJS.Timeout | null = null;
    try {
      const hello = parseFrame((await queue.next()) ?? "");
      if (hello.op !== 10) throw new Error(`网关首帧不是 hello（op=${String(hello.op)}）`);
      const intervalMs = Number(asRecord(hello.d).heartbeat_interval) || 41_250;
      const auth = sessionId
        ? { op: 6, d: { token, session_id: sessionId, seq: lastSeq ?? 0 } }
        : {
            op: 2,
            d: {
              token,
              intents: DISCORD_INTENTS_DIRECT_MESSAGES,
              properties: { os: process.platform, browser: "greywork", device: "greywork" },
            },
          };
      if (!wsSend(socket, JSON.stringify(auth))) throw new Error("鉴权帧发送失败");
      ctx.runtime.markConnected("discord");
      heartbeat = setInterval(() => wsSend(socket, JSON.stringify({ op: 1, d: lastSeq })), intervalMs);
      for (;;) {
        const raw = await queue.next();
        if (raw === null) return;
        const frame = parseFrame(raw);
        if (frame.op === 0) {
          if (typeof frame.s === "number") lastSeq = frame.s;
          const event = str(frame.t);
          if (event === "READY") {
            sessionId = str(asRecord(frame.d).session_id);
            resumeUrl = str(asRecord(frame.d).resume_gateway_url);
            lastSeq = null;
            ctx.runtime.markConnected("discord");
          } else if (event === "MESSAGE_CREATE") {
            const at = Date.now();
            const draft = normalizeDiscordMessage(asRecord(frame.d), at);
            if (draft && (draft.text.trim() || draft.media.length)) {
              const media = await materialize(ctx, at, draft.media);
              ctx.runtime.emitInbound(
                "discord",
                draft.peerId,
                draft.senderId,
                draft.at,
                {
                  messageId: draft.messageId,
                  peerId: draft.peerId,
                  nick: draft.nick,
                  senderId: draft.senderId,
                  text: draft.text,
                  media,
                  at: draft.at,
                },
                ctx.allowOtherSenders,
              );
            }
          }
        } else if (frame.op === 1) {
          wsSend(socket, JSON.stringify({ op: 1, d: lastSeq }));
        } else if (frame.op === 7 || frame.op === 9) {
          if (frame.op === 9 && frame.d !== true) {
            sessionId = null;
            resumeUrl = null;
          }
          return; // 走重连
        }
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      cleanup();
    }
  });
};

/* ==================== QQ ==================== */

const QQ_TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken";
const QQ_API_BASE = "https://api.sgroup.qq.com";
const QQ_INTENTS_PUBLIC_MESSAGES = 1 << 25;

export interface QqDraft {
  messageId: string;
  peerId: string;
  senderId: string;
  nick: string;
  text: string;
  media: { url: string; kind: MediaKind; name: string }[];
  at: number;
}

/** QQ C2C / 群 @ 事件 → 入站草稿。 */
export function normalizeQqDispatch(event: string, data: Record<string, unknown>, at: number): QqDraft | null {
  const id = str(data.id);
  if (!id) return null;
  const author = asRecord(data.author);
  let peerId: string;
  let senderId: string;
  if (event === "C2C_MESSAGE_CREATE") {
    senderId = str(author.user_openid) ?? "";
    peerId = `c2c:${senderId}`;
  } else if (event === "GROUP_AT_MESSAGE_CREATE") {
    const group = str(data.group_openid) ?? "";
    senderId = str(author.member_openid) ?? group;
    peerId = `group:${group}`;
  } else {
    return null;
  }
  if (!senderId) return null;
  const text = str(data.content) ?? "";
  const media = asArray(data.attachments)
    .map((raw) => {
      const item = asRecord(raw);
      const url = str(item.url);
      if (!url) return null;
      const name = str(item.filename) ?? "attachment";
      return { url, kind: mediaKind(str(item.content_type), name), name };
    })
    .filter((item): item is { url: string; kind: MediaKind; name: string } => item !== null);
  const seconds = Number(str(data.timestamp));
  return {
    messageId: id,
    peerId,
    senderId,
    nick: peerId,
    text,
    media,
    at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : at,
  };
}

const qq: Connector = async (ctx) => {
  const credentials = loadChannelCredentials(ctx.dataDir, "qq");
  const appId = str(credentials?.appId);
  const appSecret = str(credentials?.appSecret);
  if (!appId || !appSecret) throw new Error("QQ 机器人 AppID / AppSecret 未配置");
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let token: string | null = null;
  let tokenExpiresAt = 0;
  await loop(ctx, "网关连接", async () => {
    if (!token || tokenExpiresAt - 60 <= Date.now() / 1000) {
      const response = await httpJson(QQ_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
      });
      token = str(response.body?.access_token);
      if (!token) throw new Error(`取 access_token 失败: ${brief(response.text)}`);
      tokenExpiresAt = Date.now() / 1000 + (Number(response.body?.expires_in) || 7200);
    }
    const response = await httpJson(`${QQ_API_BASE}/gateway/bot`, {
      headers: { authorization: `QQBot ${token}` },
    });
    const gateway = str(response.body?.url);
    if (!gateway) throw new Error(`取网关地址失败: ${brief(response.text)}`);
    const socket = await openWs(gateway, ctx.signal);
    const cleanup = bindWs(ctx, socket);
    const queue = new WsQueue(socket);
    let heartbeat: NodeJS.Timeout | null = null;
    try {
      const hello = parseFrame((await queue.next()) ?? "");
      if (hello.op !== 10) throw new Error(`网关首帧不是 hello（op=${String(hello.op)}）`);
      const intervalMs = Number(asRecord(hello.d).heartbeat_interval) || 41_250;
      const auth = sessionId
        ? { op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq ?? 0 } }
        : { op: 2, d: { token: `QQBot ${token}`, intents: QQ_INTENTS_PUBLIC_MESSAGES, shard: [0, 1] } };
      if (!wsSend(socket, JSON.stringify(auth))) throw new Error("鉴权帧发送失败");
      ctx.runtime.markConnected("qq");
      heartbeat = setInterval(() => wsSend(socket, JSON.stringify({ op: 1, d: lastSeq })), intervalMs);
      for (;;) {
        const raw = await queue.next();
        if (raw === null) return;
        const frame = parseFrame(raw);
        if (frame.op === 0) {
          if (typeof frame.s === "number") lastSeq = frame.s;
          const event = str(frame.t);
          if (event === "READY") {
            sessionId = str(asRecord(frame.d).session_id);
          } else if (event === "C2C_MESSAGE_CREATE" || event === "GROUP_AT_MESSAGE_CREATE") {
            const at = Date.now();
            const draft = normalizeQqDispatch(event, asRecord(frame.d), at);
            if (draft && (draft.text.trim() || draft.media.length)) {
              const media = await materialize(ctx, at, draft.media);
              ctx.runtime.emitInbound(
                "qq",
                draft.peerId,
                draft.senderId,
                draft.at,
                {
                  messageId: draft.messageId,
                  peerId: draft.peerId,
                  senderId: draft.senderId,
                  nick: draft.nick,
                  text: draft.text,
                  media,
                  at: draft.at,
                },
                ctx.allowOtherSenders,
              );
            }
          }
        } else if (frame.op === 1) {
          wsSend(socket, JSON.stringify({ op: 1, d: lastSeq }));
        } else if (frame.op === 7 || frame.op === 9) {
          if (frame.op === 9 && frame.d !== true) sessionId = null;
          return;
        }
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      cleanup();
    }
  });
};

/* ==================== 飞书 protobuf 帧 ==================== */

interface FeishuFrame {
  seqId: number;
  logId: number;
  service: number;
  method: number;
  headers: [string, string][];
  payloadEncoding: string;
  payloadType: string;
  payload: Buffer;
}

function writeVarint(out: number[], value: number): void {
  let rest = value >>> 0;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>>= 7;
    if (rest === 0) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

function varintField(out: number[], field: number, value: number): void {
  if (value === 0) return;
  writeVarint(out, field << 3);
  writeVarint(out, value);
}

function bytesField(out: number[], field: number, bytes: Uint8Array): void {
  if (bytes.length === 0) return;
  writeVarint(out, (field << 3) | 2);
  writeVarint(out, bytes.length);
  out.push(...bytes);
}

export function encodeFeishuFrame(frame: FeishuFrame): Buffer {
  const out: number[] = [];
  varintField(out, 1, frame.seqId);
  varintField(out, 2, frame.logId);
  varintField(out, 3, frame.service);
  varintField(out, 4, frame.method);
  for (const [key, value] of frame.headers) {
    const header: number[] = [];
    bytesField(header, 1, Buffer.from(key));
    bytesField(header, 2, Buffer.from(value));
    bytesField(out, 5, Buffer.from(header));
  }
  bytesField(out, 6, Buffer.from(frame.payloadEncoding));
  bytesField(out, 7, Buffer.from(frame.payloadType));
  bytesField(out, 8, frame.payload);
  return Buffer.from(out);
}

export function decodeFeishuFrame(bytes: Buffer): FeishuFrame {
  const frame: FeishuFrame = {
    seqId: 0,
    logId: 0,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: "",
    payloadType: "",
    payload: Buffer.alloc(0),
  };
  let cursor = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (cursor >= bytes.length) throw new Error("帧截断");
      const byte = bytes[cursor++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 35) throw new Error("varint 过长");
    }
  };
  const readBytes = (): Buffer => {
    const length = readVarint();
    if (cursor + length > bytes.length) throw new Error("帧截断");
    const slice = bytes.subarray(cursor, cursor + length);
    cursor += length;
    return Buffer.from(slice);
  };
  while (cursor < bytes.length) {
    const tag = readVarint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    switch (`${field}:${wire}`) {
      case "1:0":
        frame.seqId = readVarint();
        break;
      case "2:0":
        frame.logId = readVarint();
        break;
      case "3:0":
        frame.service = readVarint();
        break;
      case "4:0":
        frame.method = readVarint();
        break;
      case "5:2": {
        const raw = readBytes();
        let inner = 0;
        let key = "";
        let value = "";
        const innerVarint = (): number => {
          let result = 0;
          let shift = 0;
          for (;;) {
            const byte = raw[inner++]!;
            result += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0) return result;
            shift += 7;
          }
        };
        while (inner < raw.length) {
          const sub = innerVarint();
          const subField = Math.floor(sub / 8);
          const length = innerVarint();
          const slice = raw.subarray(inner, inner + length).toString();
          inner += length;
          if (subField === 1) key = slice;
          else if (subField === 2) value = slice;
        }
        frame.headers.push([key, value]);
        break;
      }
      case "6:2":
        frame.payloadEncoding = readBytes().toString();
        break;
      case "7:2":
        frame.payloadType = readBytes().toString();
        break;
      case "8:2":
        frame.payload = readBytes();
        break;
      case "1:2":
      case "2:2":
      case "3:2":
      case "4:2":
      case "6:0":
      case "7:0":
      case "8:0":
        readVarint();
        break;
      default:
        if (wire === 0) readVarint();
        else if (wire === 2) readBytes();
        else if (wire === 5) cursor += 4;
        else if (wire === 1) cursor += 8;
        else throw new Error(`不支持的 wire type: ${wire}`);
    }
  }
  return frame;
}

function feishuHeader(frame: FeishuFrame, key: string): string | null {
  return frame.headers.find(([name]) => name === key)?.[1] ?? null;
}

function feishuFrame(headers: [string, string][], payload: Buffer = Buffer.alloc(0)): FeishuFrame {
  return {
    seqId: 0,
    logId: 0,
    service: 0,
    method: 0,
    headers,
    payloadEncoding: "",
    payloadType: "",
    payload,
  };
}

export interface FeishuDraft {
  messageId: string;
  peerId: string;
  nick: string;
  text: string;
  messageType: string;
  chatType: string;
  senderId: string;
  at: number;
}

/** 飞书 `im.message.receive_v1` 事件 → 入站草稿。 */
export function normalizeFeishuEvent(payload: Record<string, unknown>, at: number): FeishuDraft | null {
  const header = asRecord(payload.header);
  if (str(header.event_type) !== "im.message.receive_v1") return null;
  const event = asRecord(payload.event);
  const message = asRecord(event.message);
  const sender = asRecord(event.sender);
  const senderIds = asRecord(sender.sender_id);
  const chatType = str(message.chat_type) ?? "p2p";
  const senderId = str(senderIds.open_id) ?? "";
  const peerId = chatType === "p2p" ? senderId : (str(message.chat_id) ?? "");
  if (!peerId) return null;
  let text = "";
  try {
    const content = asRecord(JSON.parse(str(message.content) ?? "{}"));
    text = str(content.text) ?? "";
  } catch {
    // 非文本 content。
  }
  return {
    messageId: str(message.message_id) ?? "",
    peerId,
    nick: senderId || peerId,
    text,
    messageType: str(message.message_type) ?? "text",
    chatType,
    senderId: senderId || peerId,
    at,
  };
}

const feishu: Connector = async (ctx) => {
  const credentials = loadChannelCredentials(ctx.dataDir, "feishu");
  const appId = str(credentials?.appId);
  const appSecret = str(credentials?.appSecret);
  if (!appId || !appSecret) throw new Error("飞书 AppID / AppSecret 未配置");
  const domain = ctx.endpointOverride ?? "https://open.feishu.cn";
  await loop(ctx, "长连接", async () => {
    const response = await httpJson(`${domain}/callback/ws/endpoint`, {
      method: "POST",
      headers: { "content-type": "application/json", locale: "zh" },
      body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
    });
    const data = asRecord(response.body?.data);
    const url = str(data.url);
    if (response.status !== 200 || !url) throw new Error(`取长连接入口失败: ${brief(response.text)}`);
    const config = asRecord(data.client_config);
    const pingMs = (Number(config.ping_interval) || 120) * 1000;
    const socket = await openWs(url, ctx.signal);
    const cleanup = bindWs(ctx, socket);
    const queue = new WsQueue(socket);
    const ping = setInterval(() => wsSend(socket, encodeFeishuFrame(feishuFrame([["type", "ping"]]))), Math.max(pingMs, 5_000));
    try {
      ctx.runtime.markConnected("feishu");
      for (;;) {
        const raw = await queue.next();
        if (raw === null) return;
        const frame = decodeFeishuFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
        if (frame.method === 0) continue; // pong / 控制帧
        if (frame.method !== 1) continue;
        // 官方要求 3 秒内回执：先发再解析业务载荷。
        const ack = feishuFrame(
          [...frame.headers.filter(([name]) => name !== "biz_rt"), ["biz_rt", "0"]],
          Buffer.from(JSON.stringify({ code: 200, headers: {}, data: null })),
        );
        ack.seqId = frame.seqId;
        ack.logId = frame.logId;
        ack.service = frame.service;
        ack.method = frame.method;
        if (!wsSend(socket, encodeFeishuFrame(ack))) throw new Error("回执发送失败");
        if (feishuHeader(frame, "type") !== "event") continue;
        const at = Date.now();
        let payload: Record<string, unknown>;
        try {
          payload = asRecord(JSON.parse(frame.payload.toString("utf8")));
        } catch {
          continue;
        }
        const draft = normalizeFeishuEvent(payload, at);
        if (!draft) continue;
        const isText = draft.messageType === "text";
        ctx.runtime.emitInbound(
          "feishu",
          draft.peerId,
          draft.senderId,
          draft.at,
          {
            messageId: draft.messageId,
            peerId: draft.peerId,
            nick: draft.nick,
            text: isText ? draft.text : "",
            messageType: isText ? null : draft.messageType,
            chatType: draft.chatType,
            media: [],
            at: draft.at,
          },
          ctx.allowOtherSenders,
        );
      }
    } finally {
      clearInterval(ping);
      cleanup();
    }
  });
};

/* ==================== 钉钉 Stream ==================== */

const DINGTALK_OPEN_URL = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const DINGTALK_CHATBOT_TOPIC = "/v1.0/im/bot/messages/get";

export interface DingTalkDraft {
  msgId: string;
  peerId: string;
  nick: string;
  text: string;
  msgType: string | null;
  conversationType: string | null;
  at: number;
}

/** 钉钉机器人回调 data → 入站草稿。 */
export function normalizeDingtalkChatbot(raw: string, at: number): DingTalkDraft | null {
  let message: Record<string, unknown>;
  try {
    message = asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
  const peerId = str(message.senderStaffId) ?? str(message.conversationId);
  if (!peerId) return null;
  const content = str(asRecord(message.text).content) ?? "";
  const text = content.replace(/^@\S+\s*/, "").trim();
  const seconds = Number(message.createAt);
  return {
    msgId: str(message.msgId) ?? "",
    peerId,
    nick: str(message.senderNick) ?? "钉钉联系人",
    text,
    msgType: str(message.msgtype),
    conversationType: str(message.conversationType),
    at: Number.isFinite(seconds) && seconds > 0 ? seconds : at,
  };
}

const dingtalk: Connector = async (ctx) => {
  const credentials = loadChannelCredentials(ctx.dataDir, "dingtalk");
  const clientId = str(credentials?.clientId);
  const clientSecret = str(credentials?.clientSecret);
  if (!clientId || !clientSecret) throw new Error("钉钉 Client ID / Client Secret 未配置");
  await loop(ctx, "Stream 长连接", async () => {
    const response = await httpJson(ctx.endpointOverride ?? DINGTALK_OPEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        subscriptions: [{ type: "CALLBACK", topic: DINGTALK_CHATBOT_TOPIC }],
        ua: "greywork-desktop/1.0",
      }),
    });
    const endpoint = str(response.body?.endpoint);
    const ticket = str(response.body?.ticket);
    if (response.status !== 200 || !endpoint || !ticket) throw new Error(`建连失败: ${brief(response.text)}`);
    const url = `${endpoint.replace(/\?+$/, "")}?ticket=${encodeURIComponent(ticket)}`;
    const socket = await openWs(url, ctx.signal);
    const cleanup = bindWs(ctx, socket);
    const queue = new WsQueue(socket);
    const ping = setInterval(() => socket.ping(), 60_000);
    try {
      ctx.runtime.markConnected("dingtalk");
      for (;;) {
        const raw = await queue.next();
        if (raw === null) return;
        const frame = parseFrame(raw);
        const headers = asRecord(frame.headers);
        const messageId = str(headers.messageId);
        const ack = JSON.stringify({
          code: 200,
          headers: { messageId: messageId ?? "", contentType: "application/json" },
          message: "OK",
          data: "{}",
        });
        if (str(frame.type) === "CALLBACK" && str(headers.topic) === DINGTALK_CHATBOT_TOPIC) {
          const at = Date.now();
          const draft = normalizeDingtalkChatbot(str(frame.data) ?? "", at);
          if (draft) {
            const isText = draft.msgType === null || draft.msgType === "text";
            ctx.runtime.emitInbound(
              "dingtalk",
              draft.peerId,
              draft.peerId,
              draft.at,
              {
                msgId: draft.msgId,
                peerId: draft.peerId,
                nick: draft.nick,
                text: isText ? draft.text : "",
                msgType: isText ? null : draft.msgType,
                conversationType: draft.conversationType,
                media: [],
                at: draft.at,
              },
              ctx.allowOtherSenders,
            );
          }
        }
        if (messageId) wsSend(socket, ack);
        if (str(frame.type) === "SYSTEM" && str(headers.topic) === "disconnect") return;
      }
    } finally {
      clearInterval(ping);
      cleanup();
    }
  });
};

/* ==================== 企业微信智能机器人长连接 ==================== */

const WECOM_WS_URL = "wss://openws.work.weixin.qq.com";

export interface WecomDraft {
  msgId: string;
  peerId: string;
  senderId: string;
  nick: string;
  text: string;
  unsupported: string;
  at: number;
}

/** `aibot_msg_callback` → 入站草稿。 */
export function normalizeWecomCallback(body: Record<string, unknown>, at: number): WecomDraft | null {
  const sender = str(asRecord(body.from).userid);
  if (!sender) return null;
  const isGroup = str(body.chattype) === "group";
  const peerId = isGroup ? `group:${str(body.chatid) ?? ""}` : `single:${sender}`;
  if (peerId.endsWith(":")) return null;
  const msgType = str(body.msgtype) ?? "";
  let text = "";
  if (msgType === "text") text = str(asRecord(body.text).content) ?? "";
  else if (msgType === "voice") text = str(asRecord(body.voice).content) ?? "";
  else if (msgType === "mixed") {
    text = asArray(asRecord(body.mixed).msg_item)
      .map((item) => (str(asRecord(item).msgtype) === "text" ? (str(asRecord(asRecord(item).text).content) ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  const handled = msgType === "text" || (msgType === "voice" && text.trim() !== "");
  const seconds = Number(body.create_time);
  return {
    msgId: str(body.msgid) ?? "",
    peerId,
    senderId: sender,
    nick: peerId,
    text,
    unsupported: handled ? "" : msgType || "non-text",
    at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : at,
  };
}

const wecom: Connector = async (ctx) => {
  const credentials = loadChannelCredentials(ctx.dataDir, "wecom");
  const botId = str(credentials?.botId);
  const secret = str(credentials?.secret);
  if (!botId || !secret) throw new Error("企业微信 BotID / Secret 未配置");
  await loop(ctx, "长连接", async () => {
    const socket = await openWs(ctx.endpointOverride ?? WECOM_WS_URL, ctx.signal);
    const cleanup = bindWs(ctx, socket);
    const queue = new WsQueue(socket);
    const subscribeId = randomUUID();
    if (
      !wsSend(
        socket,
        JSON.stringify({
          cmd: "aibot_subscribe",
          headers: { req_id: subscribeId },
          body: { bot_id: botId, secret },
        }),
      )
    ) {
      throw new Error("订阅帧发送失败");
    }
    const ping = setInterval(() => wsSend(socket, JSON.stringify({ cmd: "ping", headers: { req_id: randomUUID() } })), 30_000);
    try {
      // 等订阅回执：期间到达的回调也照常分发。
      let subscribed = false;
      for (;;) {
        const raw = await queue.next();
        if (raw === null) return;
        const frame = parseFrame(raw);
        const headers = asRecord(frame.headers);
        if (!subscribed) {
          if (str(headers.req_id) !== subscribeId) continue;
          const errcode = frame.errcode;
          if (typeof errcode === "number" && errcode !== 0) {
            throw new Error(`企业微信拒绝订阅（${errcode}）：${str(frame.errmsg) ?? "unknown error"}`);
          }
          subscribed = true;
          ctx.runtime.markConnected("wecom");
          continue;
        }
        const cmd = str(frame.cmd);
        if (cmd === "aibot_event_callback") {
          const event = asRecord(asRecord(frame.body).event);
          if (str(event.eventtype) === "disconnected_event") {
            throw new FatalError("连接已被新的长连接接管");
          }
          continue;
        }
        if (cmd !== "aibot_msg_callback") continue;
        const at = Date.now();
        const draft = normalizeWecomCallback(asRecord(frame.body), at);
        if (!draft) continue;
        ctx.runtime.emitInbound(
          "wecom",
          draft.peerId,
          draft.senderId,
          draft.at,
          {
            msgId: draft.msgId,
            peerId: draft.peerId,
            senderId: draft.senderId,
            nick: draft.nick,
            text: draft.text,
            unsupported: draft.unsupported,
            media: [],
            at: draft.at,
          },
          ctx.allowOtherSenders,
        );
      }
    } finally {
      clearInterval(ping);
      cleanup();
    }
  });
};

/* ==================== 微信（官方 SDK） ==================== */

const wechat: Connector = async (ctx) => {
  const bot = getBot(ctx.dataDir);
  // login(force:false) 会优先载入 `<dataDir>/wechat/credentials.json`，不会触发扫码。
  await bot.login({ force: false });
  bot.removeAllListeners("message");
  bot.removeAllListeners("error");
  bot.on("message", (message) => {
    void (async () => {
      const at = Date.now();
      const type = String(message.type);
      const itemTypes: Record<string, number> = { text: 1, image: 2, voice: 3, file: 4, video: 5 };
      const media: Record<string, unknown>[] = [];
      if (type !== "text") {
        try {
          const downloaded = await bot.download(message);
          if (downloaded) {
            const kind: MediaKind = downloaded.type === "voice" ? "audio" : (downloaded.type as MediaKind);
            const name = downloaded.fileName ?? (downloaded.type === "voice" ? "voice.wav" : `${downloaded.type}.bin`);
            const ref = storeInboundMedia(inboxDir(ctx.dataDir, "wechat"), "wechat", at, 0, kind, name, downloaded.data);
            if (ref) media.push(ref);
          }
        } catch (error) {
          console.warn(`[wechat] 入站媒体下载失败: ${(error as Error).message}`);
        }
      }
      ctx.runtime.emitInbound(
        "wechat",
        message.userId,
        message.userId,
        at,
        {
          fromUserId: message.userId,
          contextToken: message._contextToken,
          text: type === "text" ? message.text : "",
          itemTypes: [itemTypes[type] ?? 0],
          media,
          createTimeMs: message.timestamp instanceof Date ? message.timestamp.getTime() : at,
          at,
        },
        ctx.allowOtherSenders,
      );
    })();
  });
  bot.on("error", (error) => {
    ctx.runtime.markError("wechat", `微信连接异常: ${(error as Error)?.message ?? String(error)}`);
  });
  await loop(ctx, "长轮询", async () => {
    ctx.runtime.markConnected("wechat");
    await bot.start();
  });
};

/* ==================== 注册表 ==================== */

export const CONNECTORS = {
  wechat,
  dingtalk,
  feishu,
  telegram,
  qq,
  discord,
  wecom,
} satisfies Record<string, Connector>;
