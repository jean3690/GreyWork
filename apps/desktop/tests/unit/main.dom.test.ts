/**
 * 桌面启动编排：bootInstalledMarketPlugins → 挂载 App → 双 rAF 后显示原生窗口（防白屏），
 * DEV 下往 window.__gw 暴露工作台钩子供 e2e 注入。
 *
 * 全部宿主外壳打桩：workbench 只保留 main/App 用到的入口，避免把整个工作台拖进测试；
 * 真实挂载仍走 createApp(App).mount("#app")，验证 #app 真的长出内容而非裸奔。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  boot: vi.fn<() => Promise<void>>(),
  show: vi.fn<() => Promise<void>>(),
  getWindow: vi.fn(),
  appPlugin: (app: unknown) => {
    void app;
  },
}));

vi.mock("@greywork/workbench", () => ({
  bootInstalledMarketPlugins: () => h.boot(),
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
    h.boot.mockResolvedValue(undefined);
    h.show.mockResolvedValue(undefined);
    h.getWindow.mockReturnValue({ show: h.show });
  });

  it("boot 插件 → 挂载 App → 双 rAF 后显示原生窗口，并暴露 __gw 钩子", async () => {
    await import("../../src/main");

    expect(h.boot).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
    const appEl = document.querySelector("#app");
    expect(appEl?.childElementCount).toBeGreaterThan(0);

    const gw = (window as unknown as { __gw?: { appEvents?: unknown } }).__gw;
    expect(gw?.appEvents).toBeDefined();
  });
});
