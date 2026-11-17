/**
 * 静态 SPA 托管：与 apps/server/src/routes/static_site.rs 同口径。
 *
 * - `/` 与未知的非资源路径回 index.html（前端是 hash 路由，不需要 history fallback，
 *   但刷新深链、favicon 这类请求仍应落到入口）。
 * - `/assets/*` 带一年 immutable（文件名含内容哈希）；其余按 no-cache，保证重新部署立刻生效。
 * - URL 路径只解码一次，字面路径与符号链接真实目标都必须在 root 内。
 * - HEAD 只发文件头；读取失败 / 客户端断连时销毁流，避免未处理异常与残留读取。
 */
import { createReadStream, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** 静态根是否可用：需要 index.html，否则 sidecar 启动就该失败（与 Rust 的启动校验一致）。 */
export function resolveStaticRoot(dir: string | null): string | null {
  if (!dir) return null;
  const index = path.join(dir, "index.html");
  try {
    const root = realpathSync(dir);
    if (resolveFile(root, "index.html")) return root;
  } catch (error) {
    throw new Error(`GREYWORK_STATIC_DIR 无效：未找到可读取的入口文件 ${index}`, { cause: error });
  }
  throw new Error(`GREYWORK_STATIC_DIR 无效：未找到可读取的入口文件 ${index}`);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 缺失文件 / 越界链接回落到入口，但不能用入口自身的链接绕过同一边界。 */
function resolveFile(root: string, relative: string): string | null {
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) return null;
  try {
    const real = realpathSync(target);
    return isInside(root, real) && statSync(real).isFile() ? real : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return null;
    throw error;
  }
}

export function serveStatic(root: string, pathname: string, res: ServerResponse, method = "GET"): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
    if (decoded.includes("\0")) throw new URIError("路径含空字节");
  } catch {
    res.writeHead(400, { "cache-control": "no-store" });
    res.end();
    return;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const requested = resolveFile(root, relative);
  const file = requested ?? resolveFile(root, "index.html");
  if (!file) {
    res.writeHead(404, { "cache-control": "no-store" });
    res.end();
    return;
  }
  // 入口（即使它链接到 assets 内）与资源缺失时的回落都不能被永久缓存。
  const isAsset = requested !== null && relative.startsWith("assets/") && path.relative(root, file).startsWith(`assets${path.sep}`);
  return sendFile(file, res, method, isAsset);
}

function sendFile(file: string, res: ServerResponse, method: string, isAsset: boolean): void {
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    "content-length": String(statSync(file).size),
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  const onClose = () => stream.destroy();
  res.once("close", onClose);
  stream.once("close", () => res.off("close", onClose));
  stream.once("error", (error) => res.destroy(error));
  stream.pipe(res);
}
