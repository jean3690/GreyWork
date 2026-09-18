/**
 * 桌面启动编排：**并发**发起 bootInstalledMarketPlugins（不等它）→ 立即挂载 App →
 * 双 rAF 后显示原生窗口（防白屏），DEV 下往 window.__gw 暴露工作台钩子供 e2e 注入。
 *
 * 「不 await」是有契约意义的：那次读盘 IPC 既不该压在首帧之前，也不该在失败时打断
 * bootstrap（以前 await 会让 IPC 失败 = 整窗永不显示）。下面两条负向用例锁住这点。
 *
 * 全部宿主外壳打桩：workbench 只保留 main/App 用到的入口，避免把整个工作台拖进测试；
 * 真实挂载仍走 createApp(App).mount("#app")，验证 #app 真的长出内容而非裸奔。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  boot: vi.fn<() => Promise<void>>(),
  loadHostOs: vi.fn<() => Promise<void>>(),
  show: vi.fn<() => Promise<void>>(),
  getWindow: vi.fn(),
  appPlugin: (app: unknown) => {
    void app;
  },
}));

vi.mock("@greywork/workbench", () => ({
  bootInstalledMarketPlugins: () => h.boot(),
  loadHostOs: () => h.loadHostOs(),
  createAppRouter: () => h.appPlugin,
  i18n: { install: h.appPlugin },
  workspaceFs: {},
  appEvents: {},
  Shell: { name: "ShellStub", template: '<div data-testid="shell-stub" />' },
  isPhysicalPointInDropzone: () => Promise.resolve(false),
  usePreviewStore: () => ({ open: () => undefined }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => h.getWindow(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => undefined) }),
}));

describe("bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    vi.clearAllMocks();
    // 打点会累积：不清掉的话 measure 可能取到上一条用例的 mark，数字失去意义。
    performance.clearMarks();
    performance.clearMeasures();
    h.boot.mockResolvedValue(undefined);
    h.loadHostOs.mockResolvedValue(undefined);
    h.show.mockResolvedValue(undefined);
    h.getWindow.mockReturnValue({ show: h.show });
  });

  it("并发发起插件引导 → 挂载 App → 双 rAF 后显示原生窗口，并暴露 __gw 钩子", async () => {
    await import("../../src/main");

    expect(h.boot).toHaveBeenCalledTimes(1);
    expect(h.loadHostOs).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
    const appEl = document.querySelector("#app");
    expect(appEl?.childElementCount).toBeGreaterThan(0);

    const gw = (window as unknown as { __gw?: { appEvents?: unknown } }).__gw;
    expect(gw?.appEvents).toBeDefined();
  });

  it("插件清单 IPC 一直不返回，也不挡挂载与窗口显示", async () => {
    // 永不 resolve：以前 await 在 mount 之前，这种情况就是一扇永远不显示的窗。
    h.boot.mockReturnValue(new Promise<void>(() => {}));
    await import("../../src/main");

    expect(document.querySelector("#app")?.childElementCount).toBeGreaterThan(0);
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  });

  it("插件清单 IPC 失败只记录，不打断挂载", async () => {
    h.boot.mockRejectedValue(new Error("ipc down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await import("../../src/main");
      expect(document.querySelector("#app")?.childElementCount).toBeGreaterThan(0);
      await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sys_info IPC 一直不返回，也不挡挂载与窗口显示", async () => {
    // 标题栏据此决定控件位置与快捷键提示，但它是**信息性**的：拿不到就按非 macOS 渲染。
    h.loadHostOs.mockReturnValue(new Promise<void>(() => {}));
    await import("../../src/main");

    expect(document.querySelector("#app")?.childElementCount).toBeGreaterThan(0);
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  });

  it("启动基线：有 gw:entry 起点时给出真实分段毫秒数", async () => {
    // 模拟 index.html 在入口模块求值前打的起点
    performance.mark("gw:entry");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await import("../../src/main");
      await vi.waitFor(() => expect(infoSpy).toHaveBeenCalledTimes(1));
      const line = String(infoSpy.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("[startup]");
      expect(line).toMatch(/模块求值\+建壳 \d+ms/);
      expect(line).toMatch(/挂载 \d+ms/);
      expect(line).toMatch(/首帧\+请求显示 \d+ms/);
      expect(line).toContain("插件清单 IPC");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("启动基线：缺 gw:entry 时退化为 —，不抛也不挡启动", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await import("../../src/main");
      await vi.waitFor(() => expect(infoSpy).toHaveBeenCalledTimes(1));
      const line = String(infoSpy.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("[startup]");
      expect(line).toMatch(/导航→窗口 show\(\) —/);
      expect(document.querySelector("#app")?.childElementCount).toBeGreaterThan(0);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
