/**
 * HTTP 面：8 条路由与 apps/server/src/routes/ 一一对应，成功响应 body 就是命令返回值，
 * 失败统一 `{ "error": "…" }`。
 *
 * P0 的取舍：
 * - 路由、认证、cookie、错误信封、静态托管按 Rust 行为实现，并有集成测试对照；
 * - CSP / Origin 白名单只做了最小实现（详见 README 的「与 Rust 的差异」），P1 补齐并加对照测试。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { clearCookie, sessionCookie, tokenFromCookie } from "./auth.js";
import type { LoginThrottle, SessionStore } from "./auth.js";
import { CommandError, dispatch, listCommands } from "./commands.js";
import { attachEvents, type EventBus } from "./events.js";
import { serveStatic } from "./static-site.js";
import type { HostConfig } from "./config.js";
import type { Db } from "./db.js";
import type { TerminalHost } from "./terminal.js";
import type { WorkspaceAccess } from "./workspace-access.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface HostServerOptions {
  config: HostConfig;
  sessions: SessionStore;
  throttle: LoginThrottle;
  staticRoot: string | null;
  access: WorkspaceAccess;
  db: Db;
  bus: EventBus;
  terminal: TerminalHost;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function securityHeaders(config: HostConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    // P0 的 CSP 只覆盖同源资源；P1 按 middleware.rs 的完整指令逐条对照补齐。
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; "),
  };
  if (config.secureCookie) {
    headers["strict-transport-security"] = "max-age=31536000";
  }
  return headers;
}

function sendJson(res: ServerResponse, status: number, payload: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extra,
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "cache-control": "no-store", ...extra });
  res.end();
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "请求体过大");
    chunks.push(buffer);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function requestToken(request: IncomingMessage): string | null {
  return tokenFromCookie(request.headers.cookie) ?? bearerToken(request);
}

function clientIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

export function createHostServer(options: HostServerOptions): { server: Server; close: () => Promise<void> } {
  const { config, sessions, throttle } = options;
  const baseHeaders = securityHeaders(config);

  const server = createServer(async (request, response) => {
    for (const [key, value] of Object.entries(baseHeaders)) response.setHeader(key, value);
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = request.method ?? "GET";

    try {
      // 非 GET/HEAD 且配置了白名单时校验 Origin（网络暴露部署的 CSRF 面）。
      if (method !== "GET" && method !== "HEAD" && config.allowedOrigins.length > 0) {
        const origin = request.headers.origin;
        if (!origin || !config.allowedOrigins.includes(origin)) {
          throw new HttpError(403, `Origin 不允许：${origin ?? "(缺失)"}`);
        }
      }

      if (pathname === "/api/health" && method === "GET") {
        return sendJson(response, 200, { status: "ok", version: config.version });
      }

      if (pathname === "/api/login" && method === "POST") {
        const ip = clientIp(request);
        if (throttle.isBlocked(ip)) throw new HttpError(429, "登录尝试过于频繁，请稍后再试");
        const body = (await readJson(request)) as { password?: unknown } | null;
        const password = typeof body?.password === "string" ? body.password : "";
        const token = await sessions.login(password);
        if (!token) {
          throttle.recordFailure(ip);
          throw new HttpError(401, "未认证");
        }
        throttle.recordSuccess(ip);
        return sendJson(
          response,
          200,
          { token },
          {
            "set-cookie": sessionCookie(token, config.sessionTtlSecs, config.secureCookie),
          },
        );
      }

      // 静态 SPA 是公开的（页面本身不含数据），与 Rust 的 `/api/**` 门禁边界一致。
      if (options.staticRoot && (method === "GET" || method === "HEAD") && !pathname.startsWith("/api/")) {
        return serveStatic(options.staticRoot, pathname, response);
      }

      // 以下端点都要求会话。
      const token = requestToken(request);
      const expiresAt = sessions.authenticate(token);
      if (expiresAt === null) throw new HttpError(401, "未认证");

      if (pathname === "/api/session" && method === "GET") {
        return sendJson(response, 200, { authenticated: true, expiresAt });
      }

      if (pathname === "/api/logout" && method === "POST") {
        sessions.revoke(token);
        return sendEmpty(response, 204, {
          "set-cookie": clearCookie(config.secureCookie),
        });
      }

      if (pathname === "/api/commands" && method === "GET") {
        return sendJson(response, 200, listCommands(config.trustedHost));
      }

      if (pathname === "/api/command" && method === "POST") {
        const body = (await readJson(request)) as { command?: unknown; args?: unknown } | null;
        try {
          const result = await dispatch(body?.command, body?.args ?? null, {
            access: options.access,
            db: options.db,
            terminal: options.terminal,
            trustedHost: config.trustedHost,
          });
          return sendJson(response, 200, result ?? null);
        } catch (error) {
          if (error instanceof CommandError) {
            return sendJson(response, error.status, { error: error.message });
          }
          throw error;
        }
      }

      throw new HttpError(404, `未知接口：${pathname}`);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) {
        console.error("[host-node] 未处理异常：", error);
      }
      return sendJson(response, status, { error: message });
    }
  });

  const detachEvents = attachEvents(server, sessions, options.bus, config.version);

  return {
    server,
    close: async () => {
      detachEvents();
      // keep-alive 连接（浏览器 / undici）会让 server.close 一直等下去：先全部断开再收尾。
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
