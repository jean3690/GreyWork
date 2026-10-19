/**
 * Web 端启动编排：设备分级 → 运行时判定 → 市场清单并发引导 → 声明 WEB_FRONT → 挂载 App → 双 rAF 后收尾打点。
 *
 * 与桌面端 `main.dom.test.ts` 的差别就是本端**不该做**的事，下面有用例锁住：
 * 不去显示窗口（浏览器没有窗口可藏）。市场插件引导本端**要做**，但必须排在运行时判定
 * 落地之后（用例锁住时序）：桌面端 Electron 壳下怎么探都是 server 态、可以先起飞；本端
 * 的 server 态靠探测，判定前调 `bootInstalledMarketPlugins()` 会恒判 browser-preview、
 * 清单永远不拉。
 *
 * 全部宿主外壳打桩：workbench 只保留 main/App 用到的入口，避免把整个工作台拖进测试；
 * 真实挂载仍走 createApp(App).mount("#app")，验证 #app 真的长出内容而非裸奔。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  loadHostSystem: vi.fn<() => Promise<void>>(),
  initDeviceTier: vi.fn<() => void>(),
  runtimeMode: vi.fn<() => "server" | "browser-preview">(() => "browser-preview"),
  initRuntimeMode: vi.fn<() => Promise<string>>(),
  bootInstalledMarketPlugins: vi.fn<() => Promise<void>>(),
  setFront: vi.fn<(front: unknown) => void>(),
  // 前端集合只作为「被声明的那个对象」的身份标记，内容由 workbench 自己的单测锁
  //（packages/workbench/tests/unit/front/web.test.ts）—— 这里不重复维护一份特性清单。
  WEB_FRONT: Object.freeze({ id: "web", features: [{ id: "guid" }, { id: "conversation" }] }),
  appPlugin: (app: unknown) => {
    void app;
  },
}));

vi.mock("@greywork/host-ipc", () => ({
  runtimeMode: h.runtimeMode,
  initRuntimeMode: h.initRuntimeMode,
}));

vi.mock("@greywork/workbench", () => ({
  loadHostSystem: () => h.loadHostSystem(),
  initDeviceTier: () => h.initDeviceTier(),
  bootInstalledMarketPlugins: () => h.bootInstalledMarketPlugins(),
  createAppRouter: () => h.appPlugin,
  // 前端身份：入口在 mount 前声明本端是哪一端，路由表与外壳接线都由它派生
  //（见 workbench 的 front/types.ts）。缺了它 bootstrap 会在 mount 之前抛。
  setFront: (front: unknown) => h.setFront(front),
  // __gw 钩子读它来暴露「本端装了哪些特性」（e2e 断言多前端子集）。
  currentFront: () => h.WEB_FRONT,
  i18n: { install: h.appPlugin },
  workspaceFs: {},
  appEvents: {},
  Shell: { name: "ShellStub", template: '<div data-testid="shell-stub" />' },
  AuthGate: { name: "AuthGateStub", template: "<div><slot /></div>" },
}));

vi.mock("@greywork/workbench/front/web", () => ({ WEB_FRONT: h.WEB_FRONT }));

/**
 * 把上一条用例遗留的 rAF 排空。
 *
 * 入口的收尾打点走**两层嵌套 rAF**（等 Vue 首帧真正画完），而用例只要在 rAF 之前断言失败，
 * 那一帧就会迟到、落进**下一条**用例的时间窗里 —— 表现为 `console.info` 被调了两次
 * （上一条的 reportStartup + 本条的），一个纯粹由测试编排造成的假失败。
 * 在每条用例的 beforeEach 里先排空，断言才能重新指回「这条用例真的只打了一次点」。
 */
function drainRaf(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

describe("bootstrap", () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    vi.clearAllMocks();
    // 打点会累积：不清掉的话 measure 可能取到上一条用例的 mark，数字失去意义。
    performance.clearMarks();
    performance.clearMeasures();
    h.loadHostSystem.mockResolvedValue(undefined);
    h.bootInstalledMarketPlugins.mockReset().mockResolvedValue(undefined);
    h.runtimeMode.mockReset().mockReturnValue("browser-preview");
    h.initRuntimeMode.mockReset().mockResolvedValue("browser-preview");
    await drainRaf();
  });

  it("声明 WEB_FRONT → 挂载 App → 收尾打点，并暴露 __gw 钩子", async () => {
    await import("../../src/main");

    // 设备分级要在 mount 之前同步落地：首帧就该按真实档位渲染。
    expect(h.initDeviceTier).toHaveBeenCalledTimes(1);
    // 前端身份同样要在 mount 之前声明，且声明的是**本端自己那一份**（不吃缺省）。
    expect(h.setFront).toHaveBeenCalledExactlyOnceWith(h.WEB_FRONT);
    expect(h.loadHostSystem).toHaveBeenCalledTimes(1);
    expect(document.querySelector("#app")?.childElementCount).toBeGreaterThan(0);
    // 市场清单引导与本端 mount 并发：入口调它，但绝不 await（IPC 晚到自会补上导航项）。
    expect(h.bootInstalledMarketPlugins).toHaveBeenCalledTimes(1);

    // e2e 钩子是**动态 import 的回调**里挂上去的（入口只给 dev 构建留了这一条通路），
    // 所以要等一个 tick 才可见 —— 同步断言会稳定地在 promise 落地之前读到 undefined。
    await vi.waitFor(() => {
      const gw = (window as unknown as { __gw?: { appEvents?: unknown } }).__gw;
      expect(gw?.appEvents).toBeDefined();
    });
    // __gw.front 是 e2e 断言「多前端」的入口：必须是本端声明的身份 + 特性 id 列表。
    const gw = (window as unknown as { __gw: { front: { id: string; features: string[] } } }).__gw;
    expect(gw.front).toEqual({ id: "web", features: ["guid", "conversation"] });
  });
  it("打点分段里没有「显示窗口」这一段 —— 本端没有窗口可显示", async () => {
    performance.mark("gw:entry");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await import("../../src/main");
      await vi.waitFor(() => expect(infoSpy).toHaveBeenCalledTimes(1));
      const line = String(infoSpy.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("[startup] 导航→首帧");
      expect(line).toMatch(/挂载 \d+ms/);
      // 桌面端那条是「导航→窗口 show()」；本端入口**根本没有** import hostWindow，
      // 所以这里既不该出现 show()，也不该出现「窗口」。
      expect(line).not.toContain("show()");
      expect(line).not.toContain("窗口");
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
      expect(line).toMatch(/导航→首帧 —/);
      expect(document.querySelector("#app")?.childElementCount).toBeGreaterThan(0);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("DEV 为 false 时不挂 __gw —— 发布包里没有这条调试通路", async () => {
    // 生产构建里整段被 dead-code 消除（Rollup 对 `if (import.meta.env.DEV)` 的结果是静态可判的），
    // 但那是构建器的行为、不该只靠注释保证；这里把 DEV 掰成 false 跑一遍同一条启动路径，
    // 锁住「不 DEV 就不挂钩子」这层**源码级**保证。
    // window 在同一文件的多条用例之间**是共享的**：上面那条用例已经把 __gw 挂上去了，
    // 不清掉的话这里读到的是它的残留，本用例会以「拿到了上一条的对象」这种假象失败。
    delete (window as unknown as Record<string, unknown>).__gw;
    vi.stubEnv("DEV", false);
    try {
      await import("../../src/main");
      // 钩子挂在动态 import 的回调里，给它一个 tick 的机会去（错误地）挂上。
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((window as unknown as { __gw?: unknown }).__gw).toBeUndefined();
      // 钩子不挂，但启动本身照旧完成。
      expect(document.querySelector("#app")?.childElementCount).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("运行时判定接线", () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    vi.clearAllMocks();
    performance.clearMarks();
    performance.clearMeasures();
    h.loadHostSystem.mockResolvedValue(undefined);
    h.bootInstalledMarketPlugins.mockResolvedValue(undefined);
    await drainRaf();
  });

  it("探测未回来之前不挂载：服务端态被误判成 browser-preview 会让登录门不弹", async () => {
    h.runtimeMode.mockReturnValue("server");
    let settleRuntime!: (mode: string) => void;
    h.initRuntimeMode.mockReturnValue(
      new Promise<string>((resolve) => {
        settleRuntime = resolve;
      }),
    );

    await import("../../src/main");

    expect(h.initRuntimeMode).toHaveBeenCalledTimes(1);
    // AuthGate 与各处守卫都**同步**读 runtimeMode()，提前挂载就会把服务端态判成浏览器预览。
    expect(document.querySelector("#app")?.childElementCount).toBe(0);
    // 同一条理由也管着市场清单：本端 server 态是**探测出来的**，判定落地前起飞会恒判
    // browser-preview，bootInstalledMarketPlugins 里的宿主守卫会当场短路、清单永远不拉。
    expect(h.bootInstalledMarketPlugins).not.toHaveBeenCalled();

    settleRuntime("server");
    await vi.waitFor(() => expect(document.querySelector("#app")?.childElementCount).toBeGreaterThan(0));
    expect(h.bootInstalledMarketPlugins).toHaveBeenCalledTimes(1);
  });
});
