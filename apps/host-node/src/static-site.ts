/**
 * 静态 SPA 托管：与 apps/server/src/routes/static_site.rs 同口径。
 *
 * - `/` 与未知的非资源路径回 index.html（前端是 hash 路由，不需要 history fallback，
 *   但刷新深链、favicon 这类请求仍应落到入口）。
 * - `/assets/*` 带一年 immutable（文件名含内容哈希）；其余按 no-cache，保证重新部署立刻生效。
 * - 路径先 `resolve` 再校验前缀：`..` 不能逃出 root（与 Rust 侧同一道 path safety 检查）。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
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
  if (!existsSync(index)) {
    throw new Error(`GREYWORK_STATIC_DIR 无效：未找到 ${index}`);
  }
  return path.resolve(dir);
}

export function serveStatic(root: string, pathname: string, res: ServerResponse): void {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    // 越界直接当成入口页，不给 403 之外的路径探测信号。
    return sendFile(path.join(root, "index.html"), res);
  }
  if (existsSync(target) && statSync(target).isFile()) {
    return sendFile(target, res);
  }
  return sendFile(path.join(root, "index.html"), res);
}

function sendFile(file: string, res: ServerResponse): void {
  const isAsset = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    "content-length": String(statSync(file).size),
  });
  createReadStream(file).pipe(res);
}
