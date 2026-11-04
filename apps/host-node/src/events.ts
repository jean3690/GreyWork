/**
 * WebSocket 事件总线：信封 `{event, payload}` 与 Rust 侧逐字一致（前端按 Tauri 的
 * `listen(name, e => e.payload)` 消费）。
 *
 * 鉴权：cookie 优先（浏览器 WS API 不能设 Authorization 头），CLI 可用 `?token=`。
 * 校验失败直接销毁 socket，不升级 —— 与 Rust 的「401 后再不建立连接」等价。
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { tokenFromCookie } from "./auth.js";
import type { SessionStore } from "./auth.js";

const HEARTBEAT_MS = 30_000;

function tokenFromRequest(request: IncomingMessage): string | null {
  const cookie = tokenFromCookie(request.headers.cookie);
  if (cookie) return cookie;
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.searchParams.get("token") || null;
}

export function attachEvents(server: Server, sessions: SessionStore): () => void {
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
    ws.send(JSON.stringify({ event: "host://hello", payload: { version: "node" } }));
    const timer = setInterval(() => {
      // 心跳只探活：客户端不回应也不踢，断线由 TCP / 浏览器侧发现。
      if (ws.readyState === ws.OPEN) ws.ping();
    }, HEARTBEAT_MS);
    timers.set(ws, timer);
    ws.on("close", () => {
      const handle = timers.get(ws);
      if (handle) clearInterval(handle);
      timers.delete(ws);
    });
  });

  server.on("upgrade", onUpgrade);

  return () => {
    server.off("upgrade", onUpgrade);
    for (const handle of timers.values()) clearInterval(handle);
    wss.close();
  };
}
