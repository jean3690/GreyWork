// 内嵌浏览器的宿主通道（lib/browser-backend）。两个易错点钉死：
// - URL 归一化里「本地服务补 http://」是一等用例 —— dev server 补 https 会 TLS 握手失败；
// - 命令名与参数名必须和宿主 browser.rs 的 browser_* 一一对应，漂移了只有运行时才炸。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostIpc = vi.hoisted(() => ({
  hasHostCommands: vi.fn<() => boolean>(() => true),
  invoke: vi.fn<(command: string, ...args: unknown[]) => Promise<unknown>>(async () => null),
  listen: vi.fn<(event: string, handler: (event: unknown) => void) => Promise<() => void>>(async () => () => {}),
}));

vi.mock("@greywork/host-ipc", () => hostIpc);

import { browserBackend, normalizeBrowserUrl, openInSystemBrowser } from "@/lib/browser-backend";

beforeEach(() => {
  hostIpc.hasHostCommands.mockReset().mockReturnValue(true);
  hostIpc.invoke.mockReset().mockResolvedValue(null);
  hostIpc.listen.mockReset().mockResolvedValue(() => {});
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

describe("browserBackend", () => {
  it("supported 跟随 hasHostCommands", () => {
    hostIpc.hasHostCommands.mockReturnValue(true);
    expect(browserBackend.supported()).toBe(true);
    hostIpc.hasHostCommands.mockReturnValue(false);
    expect(browserBackend.supported()).toBe(false);
  });

  it("open 把矩形拆成 x/y/width/height 喂给 browser_open", async () => {
    await browserBackend.open("https://example.com", { x: 10.5, y: 0, width: 480, height: 300 });
    expect(hostIpc.invoke).toHaveBeenCalledWith("browser_open", {
      url: "https://example.com",
      x: 10.5,
      y: 0,
      width: 480,
      height: 300,
    });
  });

  it("setBounds / setVisible / navigate 走各自命令且参数名对齐宿主", async () => {
    await browserBackend.setBounds({ x: 0, y: 0, width: 100, height: 100 });
    expect(hostIpc.invoke).toHaveBeenCalledWith("browser_set_bounds", { x: 0, y: 0, width: 100, height: 100 });

    await browserBackend.setVisible(false);
    expect(hostIpc.invoke).toHaveBeenCalledWith("browser_set_visible", { visible: false });

    await browserBackend.navigate("https://example.com/b");
    expect(hostIpc.invoke).toHaveBeenCalledWith("browser_navigate", { url: "https://example.com/b" });
  });

  it("back / forward / reload / stop / close 是无参命令", async () => {
    await browserBackend.back();
    await browserBackend.forward();
    await browserBackend.reload();
    await browserBackend.stop();
    await browserBackend.close();
    expect(hostIpc.invoke.mock.calls.map(([command]) => command)).toEqual([
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_stop",
      "browser_close",
    ]);
  });

  describe("onState", () => {
    it("非桌面态返回 no-op，不订阅事件", async () => {
      hostIpc.hasHostCommands.mockReturnValue(false);
      const unbind = await browserBackend.onState(() => {});
      expect(hostIpc.listen).not.toHaveBeenCalled();
      expect(() => unbind()).not.toThrow();
    });

    it("订阅 browser:state 并转发 payload，解绑透传 unlisten", async () => {
      const unlisten = vi.fn();
      hostIpc.listen.mockResolvedValue(unlisten);
      const seen: unknown[] = [];
      const unbind = await browserBackend.onState((state) => seen.push(state));

      const handler = hostIpc.listen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
      const payload = { url: "https://example.com", title: "E", loading: false, canGoBack: false, canGoForward: true };
      handler({ event: "browser:state", payload, id: 1 } as { payload: unknown });

      expect(hostIpc.listen).toHaveBeenCalledWith("browser:state", expect.any(Function));
      expect(seen).toEqual([payload]);

      unbind();
      expect(unlisten).toHaveBeenCalled();
    });
  });
});

describe("openInSystemBrowser", () => {
  it("桌面态走 open_external", async () => {
    await openInSystemBrowser("https://example.com");
    expect(hostIpc.invoke).toHaveBeenCalledWith("open_external", { url: "https://example.com" });
  });

  it("非桌面态回落 window.open", async () => {
    hostIpc.hasHostCommands.mockReturnValue(false);
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    await openInSystemBrowser("https://example.com");
    expect(hostIpc.invoke).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener");
  });
});
