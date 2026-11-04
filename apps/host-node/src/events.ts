/**
 * WebSocket 事件总线：信封 `{event, payload}` 与 Rust 侧逐字一致（前端按 Tauri 的
 * `listen(name, e => e.payload)` 消费）。
 *
 * 鉴权：cookie 优先（浏览器 WS API 不能设 Authorization 头），CLI 可用 `?token=`。
 * 校验失败直接销毁 socket，不升级 —— 与 Rust 的「401 后再不建立连接」等价。
 *
 * 事件尽力而为（与 Tauri emit 同语义）：订阅者落后就丢帧、不重放；前端重连后应重跑
 * 若干 `*_load` 命令做一次状态对齐。
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { tokenFromCookie } from "./auth.js";
import type { SessionStore } from "./auth.js";

const HEARTBEAT_MS = 30_000;

/** 事件出口：终端输出等长连接数据都经它广播给所有已订阅的 WS 客户端。 */
export class EventBus {
  private readonly clients = new Set<WebSocket>();

  add(client: WebSocket): void {
    this.clients.add(client);
  }

  remove(client: WebSocket): void {
    this.clients.delete(client);
  }

  broadcast(event: string, payload: unknown): void {
    const frame = JSON.stringify({ event, payload });
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(frame);
    }
  }

  closeAll(): void {
    for (const client of this.clients) client.close();
    this.clients.clear();
  }
}

function tokenFromRequest(request: IncomingMessage): string | null {
  const cookie = tokenFromCookie(request.headers.cookie);
  if (cookie) return cookie;
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.searchParams.get("token") || null;
}

export function attachEvents(server: Server, sessions: SessionStore, bus: EventBus, version: string): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const timers = new Map<WebSocket, NodeJS.Timeout>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/events") {
      socket.destroy();
      return;
    }
    if (!sessions.authenticate(tokenFromRequest(request))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };

  wss.on("connection", (ws: WebSocket) => {
    bus.add(ws);
    ws.send(JSON.stringify({ event: "host://hello", payload: { version } }));
    const timer = setInterval(() => {
      // 心跳只探活：客户端不回应也不踢，断线由 TCP / 浏览器侧发现。
      if (ws.readyState === ws.OPEN) ws.ping();
    }, HEARTBEAT_MS);
    timers.set(ws, timer);
    ws.on("close", () => {
      bus.remove(ws);
      const handle = timers.get(ws);
      if (handle) clearInterval(handle);
      timers.delete(ws);
    });
  });

  server.on("upgrade", onUpgrade);

  return () => {
    server.off("upgrade", onUpgrade);
    for (const handle of timers.values()) clearInterval(handle);
    // 先断开所有客户端再关服务：测试环境里 keep-alive 的 WS 会让 close 回调迟迟不来。
    (wss as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    wss.close();
  };
}
