/**
 * 网页抓取（用户输入的任意 URL）：移植 `services/web_fetch.rs` 的 SSRF 加固。
 *
 * 只允许 http/https、拒绝内嵌凭据、DNS 解析后**逐个**校验地址、把连接钉到已校验的 IP
 * （关掉 DNS-rebinding 的 TOCTOU 窗口），手动跟随最多 5 跳且每跳重做校验。
 *
 * 实现差异：Rust 用 `resolve_to_addrs` 钉 IP；Node 用自定义 `lookup` / 直接向 IP 发请求
 * （HTTPS 的 `servername` 保持原 host，证书校验不受影响）。正文提取在前端做 ——
 * 这里只负责把 HTML 原文安全取回。
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";

const MAX_WEB_FETCH_BYTES = 2 * 1024 * 1024;
const WEB_FETCH_TIMEOUT_MS = 15_000;
const WEB_FETCH_READ_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export interface WebFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
}

/** 不可访问的非公网地址（v4：环回/私网/链路本地/广播/未指定/组播/文档段/CGNAT/0.0.0.0-8）。 */
function bannedV4(bytes: number[]): boolean {
  return (
    bytes[0] === 127 ||
    bytes[0] === 10 ||
    (bytes[0] === 172 && (bytes[1] & 0xf0) === 16) ||
    (bytes[0] === 192 && bytes[1] === 168) ||
    (bytes[0] === 169 && bytes[1] === 254) ||
    bytes[0] === 0 ||
    bytes[0] >= 224 ||
    (bytes[0] === 100 && (bytes[1] & 0xc0) === 64) ||
    // 192.0.2.0/24 与 198.51.100.0/24、203.0.113.0/24（文档段）
    (bytes[0] === 192 && bytes[1] === 0 && bytes[2] === 2) ||
    (bytes[0] === 198 && bytes[1] === 51 && bytes[2] === 100) ||
    (bytes[0] === 203 && bytes[1] === 0 && bytes[2] === 113)
  );
}

export function validateIp(ip: string): void {
  const banned = (() => {
    if (ip.includes(":")) {
      // IPv4-mapped（::ffff:a.b.c.d）按 v4 规则判，否则 127.0.0.1 能绕过。
      const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      if (mapped) return bannedV4(mapped[1].split(".").map(Number));
      if (ip === "::" || ip === "::1") return true;
      const first = ip.split(":")[0] ?? "";
      const value = parseInt(first, 16);
      if (Number.isFinite(value)) {
        if ((value & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
        if ((value & 0xffc0) === 0xfe80) return true; // 链路本地 fe80::/10
        if ((value & 0xff00) === 0xff00) return true; // 组播 ff00::/8
      }
      return false;
    }
    return bannedV4(ip.split(".").map(Number));
  })();
  if (banned) throw new Error(`web fetch refuses non-public address: ${ip}`);
}

/** 绝对地址、仅 http/https、无内嵌凭据、有 host。 */
function parseTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`web fetch url is not absolute: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`web fetch only allows http/https urls, got ${url.protocol.replace(":", "")}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("web fetch does not allow embedded credentials");
  }
  if (url.hostname === "") throw new Error("web fetch url has no host");
  return url;
}

interface Resolved {
  ip: string;
  port: number;
}

async function resolveAndValidate(host: string, port: number): Promise<Resolved[]> {
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`web fetch dns resolve failed for ${host}: ${(error as Error).message}`, { cause: error });
  }
  if (addresses.length === 0) {
    throw new Error(`web fetch dns resolve returned no address for ${host}`);
  }
  const resolved: Resolved[] = addresses.map((entry) => ({ ip: entry.address, port }));
  for (const item of resolved) validateIp(item.ip);
  return resolved;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** 单跳请求：直连已校验的 IP，Host 头保留原域名，HTTPS 的 servername 同理（证书校验不降级）。 */
function fetchOnce(url: URL, resolved: Resolved, originalHost: string): Promise<RawResponse> {
  const secure = url.protocol === "https:";
  const port = resolved.port;
  const transport = secure ? https : http;
  const options: https.RequestOptions = {
    host: resolved.ip,
    port,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: {
      host: `${originalHost}${(url.protocol === "https:" && port === 443) || (url.protocol === "http:" && port === 80) ? "" : `:${port}`}`,
      "user-agent": "GreyWork-WebFetch/1",
      "accept-encoding": "identity",
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
      connection: "close",
    },
    ...(secure ? { servername: originalHost } : {}),
  };
  const request = transport.request(options);
  request.setTimeout(WEB_FETCH_TIMEOUT_MS, () => request.destroy(new Error("web fetch request timed out")));
  return (async () => {
    const [response] = (await once(request, "response")) as [http.IncomingMessage];
    const chunks: Buffer[] = [];
    let size = 0;
    const read = new Promise<Buffer>((resolve, reject) => {
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_WEB_FETCH_BYTES) {
          request.destroy();
          reject(new Error(`web fetch response exceeds ${MAX_WEB_FETCH_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", (error) => reject(new Error(`web fetch response read failed: ${error.message}`)));
    });
    const readGuard = Promise.race([
      read,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("web fetch response read timed out")), WEB_FETCH_READ_TIMEOUT_MS),
      ),
    ]);
    const body = await readGuard;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : (value ?? "");
    }
    return { status: response.statusCode ?? 0, headers, body };
  })().finally(() => request.destroy());
}

/** 内容类型白名单（忽略 charset 参数与大小写）。 */
function readableContentType(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const base = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "text/html" || base === "application/xhtml+xml" || base === "text/plain";
}

export async function fetchPage(start: string): Promise<WebFetchResult> {
  let current = parseTarget(start);
  let redirects = 0;
  for (;;) {
    const host = current.hostname;
    const port = current.port === "" ? (current.protocol === "https:" ? 443 : 80) : Number(current.port);
    const resolvedList = await resolveAndValidate(host, port);
    let lastError: Error | null = null;
    let response: RawResponse | null = null;
    for (const resolved of resolvedList) {
      try {
        response = await fetchOnce(current, resolved, host);
        break;
      } catch (error) {
        lastError = error as Error;
      }
    }
    if (!response) {
      throw new Error(`web fetch request failed: ${lastError?.message ?? "所有已解析地址均不可达"}`, { cause: lastError ?? undefined });
    }

    if (response.status >= 300 && response.status < 400) {
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`web fetch exceeded the redirect limit (${MAX_REDIRECTS})`);
      }
      redirects += 1;
      const location = response.headers.location;
      if (!location) throw new Error("web fetch redirect had no location header");
      current = parseTarget(new URL(location, current).toString());
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`web fetch returned status ${response.status}`);
    }

    const encoding = response.headers["content-encoding"] ?? "";
    if (encoding !== "" && encoding !== "identity") {
      throw new Error(`web fetch received unsupported content-encoding: ${encoding}`);
    }

    if (!readableContentType(response.headers["content-type"])) {
      throw new Error(`web fetch unsupported content-type: ${response.headers["content-type"] ?? ""}`);
    }

    return {
      finalUrl: current.toString(),
      status: response.status,
      contentType: response.headers["content-type"] ?? "text/plain",
      html: response.body.toString("utf8"),
    };
  }
}
