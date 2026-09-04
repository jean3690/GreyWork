/**
 * 极简 WebDAV 客户端（浏览器态会话落盘用）。
 *
 * 只实现会话存储需要的五个动作：建目录、写文本、读文本、列目录、删文件。
 * 刻意不引第三方 webdav 依赖 —— 需要的语义就这么点，而 fetch 已经够用。
 *
 * PROPFIND 响应用正则抽 `<href>` 而不是 DOMParser：node 测试环境没有 DOM，
 * 而 WebDAV 的 href 内容经过 URL 编码、不可能含裸 `<`，正则在这里是安全的。
 */

import type { RemoteStoreConfig } from "./remote-store-config";

const HREF_PATTERN = /<[^>]*href>([^<]*)<\/[^>]*href>/gi;

export interface WebdavClient {
  /** 建目录（已存在视为成功）。 */
  ensureDir(path: string): Promise<void>;
  putText(path: string, text: string): Promise<void>;
  /** 读文本；404 → null。 */
  getText(path: string): Promise<string | null>;
  /** 列目录下的条目名（已解码，不含目录自身）。 */
  list(dir: string): Promise<string[]>;
  /** 删文件；404 容忍。 */
  del(path: string): Promise<void>;
}

/** 基址 + 相对段 → 绝对 URL；每段单独编码（会话 id 可能含非 ASCII）。 */
function resolveUrl(base: string, path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  const root = base.replace(/\/+$/, "");
  return segments.length ? `${root}/${segments.join("/")}` : root;
}

function authHeaders(config: RemoteStoreConfig): Record<string, string> {
  if (!config.username) return {};
  return { Authorization: `Basic ${btoa(`${config.username}:${config.password ?? ""}`)}` };
}

export function createWebdavClient(config: RemoteStoreConfig): WebdavClient {
  const base = config.url.replace(/\/+$/, "");
  const headers = authHeaders(config);

  async function request(
    method: string,
    path: string,
    options?: { body?: string; extraHeaders?: Record<string, string> },
  ): Promise<Response> {
    return fetch(resolveUrl(base, path), {
      method,
      body: options?.body,
      headers: { ...headers, ...options?.extraHeaders },
    });
  }

  return {
    async ensureDir(path) {
      const response = await request("MKCOL", path);
      // 405 = 已存在（多数服务端）；301 = 已存在且被规范化重定向
      if (response.ok || response.status === 405 || response.status === 301) return;
      throw new Error(`WebDAV 建目录失败 (${response.status})`);
    },

    async putText(path, text) {
      const response = await request("PUT", path, { body: text, extraHeaders: { "Content-Type": "application/json" } });
      if (!response.ok) throw new Error(`WebDAV 写入失败 (${response.status})`);
    },

    async getText(path) {
      const response = await request("GET", path);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`WebDAV 读取失败 (${response.status})`);
      return response.text();
    },

    async list(dir) {
      const response = await request("PROPFIND", dir, { extraHeaders: { Depth: "1" } });
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`WebDAV 列目录失败 (${response.status})`);
      const xml = await response.text();
      const names: string[] = [];
      for (const match of xml.matchAll(HREF_PATTERN)) {
        const href = match[1]?.trim();
        if (!href) continue;
        const last = href.replace(/\/+$/, "").split("/").pop();
        if (!last) continue;
        let name: string;
        try {
          name = decodeURIComponent(last);
        } catch {
          name = last; // 服务端返回了非法编码：原样保留，宁可多列不要漏
        }
        // 目录自身也在 Depth:1 结果里，按名字剔除
        if (name && name !== dir.replace(/\/+$/, "").split("/").pop()) names.push(name);
      }
      return names;
    },

    async del(path) {
      const response = await request("DELETE", path);
      if (response.ok || response.status === 404) return;
      throw new Error(`WebDAV 删除失败 (${response.status})`);
    },
  };
}
