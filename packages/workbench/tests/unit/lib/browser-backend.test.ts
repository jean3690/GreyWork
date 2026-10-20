// 内嵌浏览器的宿主通道（lib/browser-backend）。
// 命令名 / 参数名 ↔ 宿主的映射现在收口在 @greywork/host-ipc 的 hostBrowser()（见其单测），
// 这里只钉本模块自有的真逻辑：URL 归一化的「本地服务补 http://」一等用例，和系统浏览器回落。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostIpc = vi.hoisted(() => ({
  // browserBackend 顶层解析一次 hostBrowser()；本文件不测委派，给 null 即可。
  hostBrowser: vi.fn<() => unknown>(() => null),
  openExternal: vi.fn<(url: string) => Promise<void>>(async () => undefined),
  hostApp: vi.fn<() => unknown>(() => null),
}));

vi.mock("@greywork/host-ipc", () => hostIpc);

import { normalizeBrowserUrl, openInSystemBrowser } from "@/lib/browser-backend";

beforeEach(() => {
  hostIpc.hostBrowser.mockReturnValue(null);
  hostIpc.hostApp.mockReset().mockReturnValue(null);
  hostIpc.openExternal.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeBrowserUrl", () => {
  it("已有协议头的地址原样透传", () => {
    expect(normalizeBrowserUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeBrowserUrl("http://localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeBrowserUrl("file:///tmp/page.html")).toBe("file:///tmp/page.html");
  });

  it("本地服务补 http:// 而不是 https://", () => {
    expect(normalizeBrowserUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeBrowserUrl("127.0.0.1:3000/api?x=1")).toBe("http://127.0.0.1:3000/api?x=1");
    expect(normalizeBrowserUrl("0.0.0.0:8080")).toBe("http://0.0.0.0:8080");
    expect(normalizeBrowserUrl("[::1]:8080")).toBe("http://[::1]:8080");
  });

  it("其余裸域名补 https://，并先 trim", () => {
    expect(normalizeBrowserUrl("  example.com/article  ")).toBe("https://example.com/article");
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
  });

  it("空串回空串（提交按钮靠这个禁用）", () => {
    expect(normalizeBrowserUrl("")).toBe("");
    expect(normalizeBrowserUrl("   ")).toBe("");
  });
});

describe("openInSystemBrowser", () => {
  it("有原生宿主时走 hostApp().openExternal", async () => {
    hostIpc.hostApp.mockReturnValue({ openExternal: hostIpc.openExternal });
    await openInSystemBrowser("https://example.com");
    expect(hostIpc.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("无原生宿主回落 window.open", async () => {
    hostIpc.hostApp.mockReturnValue(null);
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    await openInSystemBrowser("https://example.com");
    expect(hostIpc.openExternal).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener");
  });
});
