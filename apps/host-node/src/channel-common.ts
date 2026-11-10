/**
 * 聊天通道运行时的公共层：运行态接口、连接器契约、退避/HTTP/WebSocket 小工具。
 *
 * 与 Rust `channel_common` 同分工：协议细节留在各连接器，状态机与事件广播归 runtime。
 * 单独成文件是为了断开「runtime ↔ 连接器」的循环依赖（连接器只依赖这里的接口）。
 */
import WebSocket from "ws";

import type { ChannelName } from "./channel-credentials.js";

export type { ChannelName };
export type ChannelState = "stopped" | "connecting" | "connected" | "error";

/** 连接器能反向调用的宿主能力（由 ChannelRuntime 实现）。 */
export interface RuntimeApi {
  markConnected(channel: ChannelName, detail?: string | null): void;
  markConnecting(channel: ChannelName): void;
  markError(channel: ChannelName, detail: string): void;
  /**
   * 记一条入站：更新归属人 / 联系人 / 最近消息，广播 state 与 inbound 事件。
   * 归属人按 senderId 判定（QQ / 企业微信等群聊里 peerId 与 senderId 不同），
   * peerId 用于联系人计数与会话归档。
   */
  emitInbound(channel: ChannelName, peerId: string, senderId: string, at: number, dto: unknown, allowOtherSenders: boolean): void;
}

export interface ConnectorContext {
  readonly runtime: RuntimeApi;
  readonly channel: ChannelName;
  readonly dataDir: string;
  readonly signal: AbortSignal;
  readonly allowOtherSenders: boolean;
  /** 协议端点覆盖（自托管 Bot API / 本地联调；生产恒为 undefined）。 */
  readonly endpointOverride?: string;
}

/** 连接器跑到 signal 被 abort 为止；内部自行重连退避，致命错误才抛出。 */
export type Connector = (ctx: ConnectorContext) => Promise<void>;

/** 指数退避 1s → 60s，与 Rust 各通道同一条曲线。 */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(Math.max(attempt, 1), 6), 60_000);
}

/** 睡满返回 true；期间被 abort 返回 false（调用方据此干净退出循环）。 */
export function sleepOrStop(signal: AbortSignal, ms: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 远端错误体只留一段摘要，避免把整段 HTML 塞进界面。 */
export function brief(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/** 带超时的 JSON 请求：非 2xx 也返回调用方判断，body 解析失败时为 null。 */
export async function httpJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // 非 JSON 响应：调用方看 text。
  }
  return { status: response.status, body, text };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** 建 WebSocket：open 时 resolve，出错/超时/abort 时 reject；abort 会连带关掉已建连的 socket。 */
export function openWs(url: string, signal: AbortSignal, timeoutMs = 15_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("连接已取消"));
      return;
    }
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket 建连超时"));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error("连接已取消"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("open", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error(`WebSocket 建连失败: ${error.message}`));
    });
  });
}

/**
 * WS 帧队列：把事件回调转成可 `await next()` 的序列，心跳定时器与收包互不阻塞。
 * close / error 后 next() 返回 null，连接器据此退出并走重连。
 */
export class WsQueue {
  private readonly queue: (string | Buffer)[] = [];
  private waiting: ((value: string | Buffer | null) => void) | null = null;
  private closed = false;

  constructor(socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      const payload = isBinary ? Buffer.from(data as Buffer) : String(data);
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(payload);
      } else {
        this.queue.push(payload);
      }
    });
    socket.once("close", () => this.finish());
    socket.once("error", () => this.finish());
  }

  private finish(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(null);
    }
  }

  next(): Promise<string | Buffer | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() ?? null);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

/** 安全发帧：连接已关时返回 false，不抛。 */
export function wsSend(socket: WebSocket, data: string | Buffer): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(data);
    return true;
  } catch {
    return false;
  }
}
