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
  loadHostSystem: vi.fn<() => Promise<void>>(),
  initDeviceTier: vi.fn<() => void>(),
  show: vi.fn<() => Promise<void>>(),
  runtimeMode: vi.fn<() => "desktop" | "server" | "browser-preview">(() => "desktop"),
  initRuntimeMode: vi.fn<() => Promise<string>>(),
  setFront: vi.fn<(front: unknown) => void>(),
  // 前端集合只作为「被声明的那个对象」的身份标记，内容由 workbench 自己的单测锁
  //（tests/unit/lib/nav-items.test.ts）—— 这里不重复维护一份特性清单。
  ALL_FEATURES_FRONT: Object.freeze({ id: "desktop" }),
  appPlugin: (app: unknown) => {
    void app;
  },
}));

vi.mock("@greywork/host-ipc", () => ({
  runtimeMode: h.runtimeMode,
  initRuntimeMode: h.initRuntimeMode,
  hostApp: () => null,
  // 窗口显示走 host-ipc 的 hostWindow 门面（内部按运行时选 Tauri / Electron 后端）。
  hostWindow: () => ({ show: h.show }),
  // App.vue 的拖放接线：无原生拖放面 → 走 HTML5（这里只保证 bootstrap 不报错）。
  hostDragDrop: () => null,
}));

vi.mock("@greywork/workbench", () => ({
  bootInstalledMarketPlugins: () => h.boot(),
  loadHostSystem: () => h.loadHostSystem(),
  initDeviceTier: () => h.initDeviceTier(),
  createAppRouter: () => h.appPlugin,
  // 前端身份：入口在 mount 前声明本端是哪一端，路由表与外壳接线都由它派生
  //（见 workbench 的 front/types.ts）。缺了它 bootstrap 会在 mount 之前抛。
  setFront: (front: unknown) => h.setFront(front),
  i18n: { install: h.appPlugin },
  workspaceFs: {},
  appEvents: {},
  Shell: { name: "ShellStub", template: '<div data-testid="shell-stub" />' },
  AuthGate: { name: "AuthGateStub", template: "<div><slot /></div>" },
  isPhysicalPointInDropzone: () => Promise.resolve(false),
  usePreviewStore: () => ({ open: () => undefined }),
}));

vi.mock("@greywork/workbench/front/all", () => ({ ALL_FEATURES_FRONT: h.ALL_FEATURES_FRONT }));

describe("bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    vi.clearAllMocks();
    // 打点会累积：不清掉的话 measure 可能取到上一条用例的 mark，数字失去意义。
    performance.clearMarks();
    performance.clearMeasures();
    h.boot.mockResolvedValue(undefined);
    h.loadHostSystem.mockResolvedValue(undefined);
    h.show.mockResolvedValue(undefined);
    // 默认按桌面态：既有的「不挡挂载」用例都建立在 mount 同步发生之上。
    h.runtimeMode.mockReset().mockReturnValue("desktop");
    h.initRuntimeMode.mockReset().mockResolvedValue("desktop");
  });

  it("并发发起插件引导 → 挂载 App → 双 rAF 后显示原生窗口，并暴露 __gw 钩子", async () => {
    await import("../../src/main");

    expect(h.boot).toHaveBeenCalledTimes(1);
    expect(h.loadHostSystem).toHaveBeenCalledTimes(1);
    // 设备分级要在 mount 之前同步落地：首帧就该按真实档位渲染。
    expect(h.initDeviceTier).toHaveBeenCalledTimes(1);
    // 前端身份同样要在 mount 之前声明：路由表与外壳接线都在 setup / mount 期读它。
    // 桌面端要的是「全部特性」那一个集合 —— 不吃 currentFront() 的缺省是有意的
    //（理由见 src/main.ts），这条断言把它钉住。
    expect(h.setFront).toHaveBeenCalledExactlyOnceWith(h.ALL_FEATURES_FRONT);
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
    h.loadHostSystem.mockReturnValue(new Promise<void>(() => {}));
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

describe("运行时判定接线", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    vi.clearAllMocks();
    performance.clearMarks();
    performance.clearMeasures();
    h.boot.mockResolvedValue(undefined);
    h.loadHostSystem.mockResolvedValue(undefined);
    h.show.mockResolvedValue(undefined);
  });

  it("非桌面态：先探测运行时再挂载，探测未回来之前不挂载", async () => {
    h.runtimeMode.mockReturnValue("server");
    let settleRuntime!: (mode: string) => void;
    h.initRuntimeMode.mockReturnValue(
      new Promise<string>((resolve) => {
        settleRuntime = resolve;
      }),
    );

    await import("../../src/main");

    expect(h.initRuntimeMode).toHaveBeenCalledTimes(1);
    // 探测没回来之前不能挂载：AuthGate 与各处守卫都**同步**读 runtimeMode()，
    // 提前挂载会把服务端态误判成 browser-preview（登录门不弹、宿主能力全禁）。
    expect(document.querySelector("#app")?.childElementCount).toBe(0);

    settleRuntime("server");
    await vi.waitFor(() => expect(document.querySelector("#app")?.childElementCount).toBeGreaterThan(0));
  });
});
