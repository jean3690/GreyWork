/**
 * 宿主事件门面：desktop 走 Tauri 事件总线，server 走服务端单条 WebSocket。
 *
 * 服务端只有一个 `/api/events` 端点，所以这里维护**一条**共享连接 + 「事件名 → 处理器集合」的
 * 多路分发。投递形状刻意与 Tauri 的 `listen` 一致（处理器收到 `{ payload }`），消费端零改动。
 *
 * 事件是有损的（服务端不重放）：断线重连后需要重新拉取的 store 订阅 `HOST_HELLO_EVENT` 即可 ——
 * 服务端每次（重）连都会先发这一帧，门面不额外合成重连事件。
 *
 * WS 不承担「认证失败」判定：浏览器 WebSocket API 拿不到握手阶段的 HTTP 状态。重弹登录门的
 * 唯一触发源是 `invoke` 收到的 HTTP 401；WS 只管退避重连，重新登录后自然连上。
 */

import { listen as tauriListen } from "@tauri-apps/api/event";

import { HostUnavailableError, runtimeMode } from "./runtime";

/** 与 `@tauri-apps/api/event` 的 `UnlistenFn` 同名同型。 */
export type UnlistenFn = () => void;

/** 与 Tauri `Event<T>` 的形状对齐：消费端一律读 `event.payload`。 */
export interface HostEvent<T> {
  payload: T;
}

/** 服务端每次（重）连都会先发的帧，也是「可以重新 hydrate 了」的信号。 */
export const HOST_HELLO_EVENT = "host://hello";

const EVENTS_PATH = "/api/events";
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

type Handler = (event: HostEvent<unknown>) => void;

/** 事件名 → 处理器集合。跨断线保留，重连后自动继续投递。 */
const handlers = new Map<string, Set<Handler>>();
let socket: WebSocket | null = null;
let retryMs = INITIAL_RETRY_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export async function listen<T = unknown>(event: string, handler: (event: HostEvent<T>) => void): Promise<UnlistenFn> {
  const mode = runtimeMode();
  if (mode === "desktop") {
    const unlisten = await tauriListen<T>(event, handler);
    return () => unlisten();
  }
  if (mode === "browser-preview") {
    // 抛错而非静默 no-op：与 invoke 一致，也与「缺宿主时 Tauri listen 自己会抛」的既有行为一致。
    throw new HostUnavailableError(`事件 ${event}`);
  }
  return subscribe(event, handler as Handler);
}

/** 注册处理器并确保连接存在；返回**同步**解绑函数（满足 UnlistenFn[] 收集-释放的惯例）。 */
function subscribe(event: string, handler: Handler): UnlistenFn {
  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(handler);
  handlers.set(event, set);
  ensureSocket();
  return () => {
    const current = handlers.get(event);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) handlers.delete(event);
    // 最后一个订阅者退订即拆连接，不为「以后可能还要用」白占一条 WS。
    if (handlers.size === 0) teardown();
  };
}

function ensureSocket(): void {
  if (socket || typeof WebSocket === "undefined" || typeof location === "undefined") return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // 同源绝对地址：浏览器自动带上 gw_session cookie，JS 侧永不持有 token。
  const next = new WebSocket(`${protocol}//${location.host}${EVENTS_PATH}`);
  socket = next;
  next.addEventListener("open", () => {
    retryMs = INITIAL_RETRY_MS;
  });
  next.addEventListener("message", (message) => dispatch(message.data));
  next.addEventListener("close", () => {
    // teardown() 会先把 socket 置空再 close，这里据此忽略那次 close。
    if (socket !== next) return;
    socket = null;
    scheduleReconnect();
  });
}

function dispatch(raw: unknown): void {
  if (typeof raw !== "string") return;
  let frame: { event?: unknown; payload?: unknown };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return;
  }
  if (typeof frame.event !== "string") return;
  const set = handlers.get(frame.event);
  if (!set) return;
  const event: HostEvent<unknown> = { payload: frame.payload };
  for (const handler of [...set]) {
    try {
      handler(event);
    } catch (error) {
      console.error(`[host-ipc] ${frame.event} 处理器失败`, error);
    }
  }
}

function scheduleReconnect(): void {
  if (handlers.size === 0 || retryTimer) return;
  const delay = retryMs + Math.random() * 250;
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    ensureSocket();
  }, delay);
}

function teardown(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryMs = INITIAL_RETRY_MS;
  const current = socket;
  socket = null;
  current?.close();
}
