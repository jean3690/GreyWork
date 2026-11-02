import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as HostIpc from "@greywork/host-ipc";

const windowMock = vi.hoisted(() => ({
  label: "plugin-window-demo.pet",
  startDragging: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  // 置顶切换：默认返回传给它的目标状态（真实宿主返回窗口的实际状态）。
  setAlwaysOnTop: vi.fn((next: boolean) => Promise.resolve(next)),
}));

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof HostIpc>()),
  hostWindow: () => windowMock,
}));
const marketMock = vi.hoisted(() => ({ installedMarketPlugins: { value: [] as unknown[] } }));
vi.mock("@/plugins/market", () => ({ installedMarketPlugins: marketMock.installedMarketPlugins }));

import PluginWindowView from "@/features/plugins/PluginWindowView.vue";

describe("插件悬浮窗移动", () => {
  beforeEach(() => {
    windowMock.startDragging.mockClear();
    windowMock.setAlwaysOnTop.mockClear();
    windowMock.label = "plugin-window-demo.pet";
    marketMock.installedMarketPlugins.value = [];
  });

  it("按住窗口内容时启动原生窗口拖拽", async () => {
    const wrapper = mount(PluginWindowView);
    await flushPromises();

    await wrapper.get('[data-testid="plugin-window"]').trigger("mousedown", { button: 0 });
    await flushPromises();

    expect(windowMock.startDragging).toHaveBeenCalledTimes(1);
  });

  it("非左键不会启动窗口拖拽", async () => {
    const wrapper = mount(PluginWindowView);
    await flushPromises();

    await wrapper.get('[data-testid="plugin-window"]').trigger("mousedown", { button: 2 });
    await flushPromises();

    expect(windowMock.startDragging).not.toHaveBeenCalled();
  });
});

/** 最小可显示包：worker + render + window 声明（标题 / 多开字段都带上）。 */
function petPackage(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: "self.onmessage = () => {};",
    manifest: {
      id: "demo.pet",
      name: "Demo Pet",
      version: "1.0.0",
      kind: "worker",
      runtime: {
        runtimeType: "worker",
        entry: "https://example.com/demo.js",
        sha256: "a".repeat(64),
        render: { handler: "draw", fps: 12 },
      },
      requires: ["window.floating"],
      window: { width: 160, height: 140, title: "桌面宠物", alwaysOnTop: false, multiple: true },
      contributes: { modes: [] },
      ...overrides,
    },
  };
}

describe("悬浮窗 v2 形态", () => {
  beforeEach(() => {
    windowMock.setAlwaysOnTop.mockClear();
    windowMock.label = "plugin-window-demo.pet";
    marketMock.installedMarketPlugins.value = [];
  });

  it("多开标签 ::2 仍能反查出插件，标题取 window.title", async () => {
    marketMock.installedMarketPlugins.value = [petPackage()];
    windowMock.label = "plugin-window-demo.pet::2";

    const wrapper = mount(PluginWindowView);
    await flushPromises();

    // 反查成功（否则窗口里只有一行错误文案，标题区为空）。
    expect(wrapper.text()).toContain("桌面宠物");
  });

  it("「钉住」按当前状态取反，并以宿主返回的实际状态为准", async () => {
    windowMock.setAlwaysOnTop.mockResolvedValueOnce(false);
    const wrapper = mount(PluginWindowView);
    await flushPromises();

    const pin = wrapper.get('[data-testid="plugin-window-pin"]');
    // 缺省置顶（manifest 未声明 alwaysOnTop 时也置顶）。
    expect(pin.attributes("aria-pressed")).toBe("true");

    await pin.trigger("click");
    await flushPromises();
    expect(windowMock.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(pin.attributes("aria-pressed")).toBe("false");
  });

  it("manifest 声明 alwaysOnTop: false 时按钮初始为未钉住", async () => {
    marketMock.installedMarketPlugins.value = [petPackage()];
    const wrapper = mount(PluginWindowView);
    await flushPromises();

    expect(wrapper.get('[data-testid="plugin-window-pin"]').attributes("aria-pressed")).toBe("false");
  });
});
