/**
 * WebDAV 客户端契约：URL 拼接与 Basic 认证、MKCOL 已存在容忍、GET 404→null、
 * PROPFIND 响应解析出文件名（不依赖 DOM，node 环境直接跑）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebdavClient } from "../../../src/lib/webdav";

const config = { kind: "webdav" as const, url: "https://dav.test/gw/", username: "u", password: "p" };
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWebdavClient", () => {
  it("逐段编码路径、去掉基址尾斜杠，并带 Basic 认证头", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("payload") });
    const client = createWebdavClient(config);
    await client.getText("sessions/会话 1.json");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://dav.test/gw/sessions/${encodeURIComponent("会话 1.json")}`);
    expect(init.headers.Authorization).toBe(`Basic ${btoa("u:p")}`);
  });

  it("未配用户名时不带认证头", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    await createWebdavClient({ kind: "webdav", url: "https://dav.test/gw" }).getText("x");
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBeUndefined();
  });

  it("MKCOL 遇 405 视为目录已存在", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 405 });
    await expect(createWebdavClient(config).ensureDir("sessions")).resolves.toBeUndefined();
  });

  it("MKCOL 其它失败码抛错", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(createWebdavClient(config).ensureDir("sessions")).rejects.toThrow("403");
  });

  it("GET 404 → null；其它失败码抛错", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve("") });
    expect(await createWebdavClient(config).getText("missing.json")).toBeNull();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("") });
    await expect(createWebdavClient(config).getText("boom.json")).rejects.toThrow("500");
  });

  it("PROPFIND 解析出条目名并剔除目录自身", async () => {
    const xml = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/gw/sessions/</d:href></d:response>
        <d:response><d:href>/gw/sessions/ses-a.json</d:href></d:response>
        <d:response><d:href>/gw/sessions/%E4%BC%9A%E8%AF%9D.json</d:href></d:response>
      </d:multistatus>`;
    fetchMock.mockResolvedValue({ ok: true, status: 207, text: () => Promise.resolve(xml) });
    const names = await createWebdavClient(config).list("sessions");
    expect(names).toEqual(["ses-a.json", "会话.json"]);
    expect(fetchMock.mock.calls[0]![1].headers.Depth).toBe("1");
  });

  it("DELETE 容忍 404", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(createWebdavClient(config).del("sessions/gone.json")).resolves.toBeUndefined();
  });
});
