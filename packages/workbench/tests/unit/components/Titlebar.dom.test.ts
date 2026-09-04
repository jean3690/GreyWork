// 无边框窗口的控制键契约：桌面壳里右上角渲染最小化/最大化/关闭三键，各自打对应的窗口命令；
// 最大化态换成「向下还原」的图标与标签，且状态只认 tauri://resize 的回灌（双击标题栏走同一条路）；
// 浏览器态没有宿主窗口可控，整组不渲染；卸载时反注册监听，不留悬挂 listener。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  isMaximized: vi.fn(() => Promise.resolve(false)),
  unlisten: vi.fn(),
  onResized: vi.fn(),
  resized: { handler: null as (() => void) | null },
}));

h.onResized.mockImplementation((handler: () => void) => {
  h.resized.handler = handler;
  return Promise.resolve(h.unlisten);
});

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => h }));
vi.mock("vue-router", () => ({ useRoute: () => ({ path: "/assistants" }) }));

import Titlebar from "@/components/Titlebar.vue";
import { usePreviewStore } from "@/stores/preview";

async function mountTitlebar() {
  const wrapper = mount(Titlebar, { props: { collapsed: false } });
  await flushPromises();
  return wrapper;
}

describe("标题栏窗口控制键", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.minimize.mockClear();
    h.toggleMaximize.mockClear();
    h.close.mockClear();
    h.unlisten.mockClear();
    h.onResized.mockClear();
    h.isMaximized.mockResolvedValue(false);
    h.resized.handler = null;
    vi.stubGlobal("__TAURI_INTERNALS__", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("三个键各打一条窗口命令", async () => {
    const wrapper = await mountTitlebar();

    await wrapper.get('[data-testid="win-minimize"]').trigger("click");
    await wrapper.get('[data-testid="win-maximize"]').trigger("click");
    await wrapper.get('[data-testid="win-close"]').trigger("click");

    expect(h.minimize).toHaveBeenCalledTimes(1);
    expect(h.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("最大化态显示向下还原", async () => {
    h.isMaximized.mockResolvedValue(true);
    const wrapper = await mountTitlebar();

    expect(wrapper.get('[data-testid="win-maximize"]').attributes("aria-label")).toBe("向下还原");
  });

  it("窗口尺寸变化后重读最大化状态", async () => {
    const wrapper = await mountTitlebar();
    expect(wrapper.get('[data-testid="win-maximize"]').attributes("aria-label")).toBe("最大化");

    h.isMaximized.mockResolvedValue(true);
    h.resized.handler?.();
    await flushPromises();

    expect(wrapper.get('[data-testid="win-maximize"]').attributes("aria-label")).toBe("向下还原");
  });

  it("浏览器态不渲染控制键", async () => {
    vi.unstubAllGlobals();
    const wrapper = await mountTitlebar();

    expect(wrapper.find('[data-testid="win-controls"]').exists()).toBe(false);
    expect(h.onResized).not.toHaveBeenCalled();
  });

  it("卸载时反注册 resize 监听", async () => {
    const wrapper = await mountTitlebar();
    wrapper.unmount();

    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("标题栏右栏开关", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("__TAURI_INTERNALS__", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("视口支持右栏时渲染开关，点击切换折叠态", async () => {
    const wrapper = await mountTitlebar();
    const preview = usePreviewStore();

    const button = wrapper.get('[data-testid="titlebar-preview-toggle"]');
    expect(button.attributes("aria-label")).toBe("展开预览面板");

    await button.trigger("click");
    expect(preview.collapsed).toBe(false);
    expect(wrapper.get('[data-testid="titlebar-preview-toggle"]').attributes("aria-label")).toBe("折叠预览面板");
  });

  it("窄屏（右栏不渲染）时开关一并消失 —— 不留一个点了没反应的按钮", async () => {
    const wrapper = await mountTitlebar();
    usePreviewStore().setAvailable(false);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="titlebar-preview-toggle"]').exists()).toBe(false);
  });
});
