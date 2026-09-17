import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const windowMock = vi.hoisted(() => ({
  label: "plugin-window-demo.pet",
  startDragging: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowMock }));
vi.mock("@/plugins/market", () => ({ installedMarketPlugins: { value: [] } }));

import PluginWindowView from "@/features/plugins/PluginWindowView.vue";

describe("插件悬浮窗移动", () => {
  beforeEach(() => {
    windowMock.startDragging.mockClear();
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
