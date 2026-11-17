import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveStaticRoot, serveStatic } from "../src/static-site.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

// 故意把静态根放在名为 assets 的父目录中，缓存策略不能依赖绝对路径中的目录名。
const temp = mkdtempSync(path.join(tmpdir(), "gw-static-"));
const root = path.join(temp, "assets", "site");
const outside = path.join(temp, "private");
const index = "<!doctype html><title>GreyWork</title>";
mkdirSync(path.join(root, "assets"), { recursive: true });
mkdirSync(outside);
writeFileSync(path.join(root, "index.html"), index);
writeFileSync(path.join(root, "assets", "app.js"), "console.log('ok')");
writeFileSync(path.join(root, "中文 文件.txt"), "中文内容");
writeFileSync(path.join(root, "literal%20name.txt"), "literal percent");
writeFileSync(path.join(outside, "secret.txt"), "private-secret");
symlinkSync(path.join(outside, "secret.txt"), path.join(root, "secret.txt"), "file");
symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
symlinkSync(path.join(root, "assets", "app.js"), path.join(root, "alias.js"), "file");
const rootLink = path.join(temp, "site-link");
symlinkSync(root, rootLink, process.platform === "win32" ? "junction" : "dir");

const staticRoot = resolveStaticRoot(root)!;
const server = createServer((request, response) => {
  // 与真实宿主一样把 URL.pathname 交给静态托管；它仍保留百分号编码。
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  serveStatic(staticRoot, pathname, response, request.method);
});
let origin = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => vi.mocked(fs.createReadStream).mockClear());

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(temp, { recursive: true, force: true });
});

describe("静态托管的路径与 HTTP 边界", () => {
  it("入口不受父目录 assets 名称影响，只有根内 assets 资源长期缓存", async () => {
    const entry = await fetch(origin);
    expect(entry.headers.get("cache-control")).toBe("no-cache");
    expect(await entry.text()).toBe(index);
    const asset = await fetch(`${origin}/assets/app.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe("console.log('ok')");
  });

  it("解析静态根的真实路径，并拒绝以目录代替 index.html", () => {
    expect(resolveStaticRoot(rootLink)).toBe(realpathSync(root));
    const invalid = path.join(temp, "invalid");
    mkdirSync(path.join(invalid, "index.html"), { recursive: true });
    expect(() => resolveStaticRoot(invalid)).toThrow("GREYWORK_STATIC_DIR 无效");
    expect(resolveStaticRoot(null)).toBeNull();
  });

  it("启动时拒绝链接到静态根外的入口文件", () => {
    const invalid = path.join(temp, "outside-index");
    mkdirSync(invalid);
    symlinkSync(path.join(outside, "secret.txt"), path.join(invalid, "index.html"), "file");
    expect(() => resolveStaticRoot(invalid)).toThrow("GREYWORK_STATIC_DIR 无效");
  });

  it.each(["/secret.txt", "/linked/secret.txt"])("符号链接 %s 不得公开静态根外的文件", async (route) => {
    const response = await fetch(origin + route);
    expect(await response.text()).toBe(index);
  });

  it("根内符号链接仍可作为静态资源读取", async () => {
    const response = await fetch(`${origin}/alias.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log('ok')");
  });

  it("正确读取 URL 编码的中文与空格文件名", async () => {
    const response = await fetch(`${origin}/${encodeURIComponent("中文 文件.txt")}`);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("中文内容");
  });

  it("文件名中的百分号只解码一次", async () => {
    const response = await fetch(`${origin}/${encodeURIComponent("literal%20name.txt")}`);
    expect(await response.text()).toBe("literal percent");
  });

  it.each(["/%ZZ", "/%00.txt"])("无效路径 %s 回 400 而不是返回入口", async (route) => {
    const response = await fetch(origin + route);
    expect(response.status).toBe(400);
    await response.text();
  });

  it("编码的路径穿越仍不能逃出静态根", async () => {
    const response = await fetch(`${origin}/..%2f..%2fprivate%2fsecret.txt`);
    expect(await response.text()).toBe(index);
  });

  it("HEAD 仅返回与 GET 一致的文件头，不创建文件读取流", async () => {
    const response = await fetch(`${origin}/assets/app.js`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength("console.log('ok')")));
    expect(await response.text()).toBe("");
    expect(fs.createReadStream).not.toHaveBeenCalled();
  });

  it("读取流出错只终止当前响应，宿主仍可服务下一次请求", async () => {
    const createReadStream = vi.mocked(fs.createReadStream).getMockImplementation()!;
    vi.mocked(fs.createReadStream).mockImplementationOnce((...args) => {
      const stream = createReadStream(...args);
      stream.destroy(new Error("模拟文件读取失败"));
      return stream;
    });
    await expect(fetch(`${origin}/assets/app.js`)).rejects.toThrow();
    const response = await fetch(origin);
    expect(await response.text()).toBe(index);
  });

  it("启动后入口被换成根外链接，回落仍不会公开私有内容", async () => {
    const entry = path.join(root, "index.html");
    unlinkSync(entry);
    symlinkSync(path.join(outside, "secret.txt"), entry, "file");
    try {
      const response = await fetch(`${origin}/missing`);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    } finally {
      unlinkSync(entry);
      writeFileSync(entry, index);
    }
  });

  it("入口链接到根内 assets 时，入口与资源回落仍必须重新验证缓存", async () => {
    const entry = path.join(root, "index.html");
    const target = path.join(root, "assets", "entry.html");
    writeFileSync(target, index);
    unlinkSync(entry);
    symlinkSync(target, entry, "file");
    try {
      for (const route of ["/", "/index.html", "/assets/missing.js"]) {
        const response = await fetch(origin + route);
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(await response.text()).toBe(index);
      }
    } finally {
      unlinkSync(entry);
      writeFileSync(entry, index);
    }
  });
});
