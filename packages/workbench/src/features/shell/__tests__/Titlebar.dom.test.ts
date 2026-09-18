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
vi.mock("vue-router", () => ({ useRoute: () => ({ path: "/assistants" }), useRouter: () => ({ push: vi.fn() }) }));

import Titlebar from "@/features/shell/Titlebar.vue";
import Hint from "@/features/shared/Hint.vue";
import { i18n } from "@/i18n";
import { hostOs } from "@/lib/host-platform";
import { usePreviewStore } from "@/stores/preview";

async function mountTitlebar() {
  // 布局指示器用 useI18n() 取模式名，所以要装 i18n 插件
  const wrapper = mount(Titlebar, { props: { collapsed: false }, global: { plugins: [i18n] } });
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

// macOS 上窗口是 decorations:false（没有原生红绿灯），控件仍自绘，但按平台习惯放左侧
// 且顺序相反；快捷键提示写 ⌘ 而不是 Ctrl。hostOs 未回来时一律按非 macOS 走。
describe("标题栏 macOS 适配", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    hostOs.value = null;
    vi.stubGlobal("__TAURI_INTERNALS__", {});
  });

  afterEach(() => {
    hostOs.value = null;
    vi.unstubAllGlobals();
  });

  it("非 macOS 时控件靠 order-last 甩到最右，提示写 Ctrl+K", async () => {
    const wrapper = await mountTitlebar();
    const controls = wrapper.get('[data-testid="win-controls"]');

    expect(controls.classes()).toContain("order-last");
    expect(wrapper.get('[data-testid="titlebar-search"]').attributes("aria-label")).toBe("搜索");
    // 顺序仍是 最小化 → 最大化 → 关闭
    expect(controls.findAll("button").map((button) => button.attributes("data-testid"))).toEqual([
      "win-minimize",
      "win-maximize",
      "win-close",
    ]);
  });

  it("macOS 时控件留在左侧且顺序反转为 关闭 → 最大化 → 最小化", async () => {
    hostOs.value = "macos";
    const wrapper = await mountTitlebar();
    const controls = wrapper.get('[data-testid="win-controls"]');

    expect(controls.classes()).not.toContain("order-last");
    expect(controls.classes()).toContain("-ml-2");
    expect(controls.findAll("button").map((button) => button.attributes("data-testid"))).toEqual([
      "win-close",
      "win-maximize",
      "win-minimize",
    ]);
  });

  it("macOS 提示写 ⌘K，其余平台写 Ctrl+K", async () => {
    // 提示文案挂在 Hint 的 prop 上（reka 的弹层只在悬停/聚焦时才 portal 出来，
    // 所以不能断言 wrapper.text()）。
    hostOs.value = "macos";
    const mac = await mountTitlebar();
    expect(mac.getComponent(Hint).props("text")).toContain("⌘K");

    hostOs.value = "linux";
    const linux = await mountTitlebar();
    expect(linux.getComponent(Hint).props("text")).toContain("Ctrl+K");
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

describe("标题栏工作区栏开关", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("__TAURI_INTERNALS__", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("视口支持时渲染这个显式开关；默认折叠（旧单右栏布局），点击展开再点折叠", async () => {
    const wrapper = await mountTitlebar();
    const { useWorkspacePanelStore } = await import("@/stores/workspacePanel");
    const workspace = useWorkspacePanelStore();

    const button = wrapper.get('[data-testid="titlebar-workspace-toggle"]');
    expect(button.attributes("aria-label")).toBe("展开工作区面板");
    expect(workspace.collapsed).toBe(true);

    await button.trigger("click");
    expect(workspace.collapsed).toBe(false);
    expect(wrapper.get('[data-testid="titlebar-workspace-toggle"]').attributes("aria-label")).toBe("折叠工作区面板");

    await wrapper.get('[data-testid="titlebar-workspace-toggle"]').trigger("click");
    expect(workspace.collapsed).toBe(true);
  });

  it("窄屏（工作区栏不渲染）时开关一并消失", async () => {
    const wrapper = await mountTitlebar();
    const { useWorkspacePanelStore } = await import("@/stores/workspacePanel");
    useWorkspacePanelStore().setAvailable(false);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="titlebar-workspace-toggle"]').exists()).toBe(false);
  });
});

describe("标题栏活动面板开关", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("视口可用时渲染开关，点击展开/收起并落盘", async () => {
    const wrapper = await mountTitlebar();
    const { useActivityStore } = await import("@/stores/activity");
    const activity = useActivityStore();

    const button = wrapper.get('[data-testid="titlebar-activity-toggle"]');
    expect(button.attributes("aria-label")).toBe("展开活动面板");
    expect(activity.open).toBe(false);

    await button.trigger("click");
    expect(activity.open).toBe(true);
    expect(wrapper.get('[data-testid="titlebar-activity-toggle"]').attributes("aria-label")).toBe("收起活动面板");
    expect(window.localStorage.getItem("greywork.activity.band")).toBe('{"open":true,"active":null}');

    await wrapper.get('[data-testid="titlebar-activity-toggle"]').trigger("click");
    expect(activity.open).toBe(false);
    expect(window.localStorage.getItem("greywork.activity.band")).toBe('{"open":false,"active":null}');
  });

  it("窄屏（活动面板不渲染）时开关一并消失", async () => {
    const wrapper = await mountTitlebar();
    const { useActivityStore } = await import("@/stores/activity");
    useActivityStore().setAvailable(false);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="titlebar-activity-toggle"]').exists()).toBe(false);
  });
});

describe("标题栏搜索", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  it("搜索按钮紧挨侧栏开合键，点击开合搜索面板", async () => {
    const wrapper = await mountTitlebar();
    const button = wrapper.get('[data-testid="titlebar-search"]');
    // aria-expanded 由 PopoverTrigger 提供（不再手写）
    expect(button.attributes("aria-label")).toBe("搜索");
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-testid="search-panel"]')).toBeNull();

    await button.trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="titlebar-search"]').attributes("aria-expanded")).toBe("true");
    // 面板经 Popover Portal 到 body（绕开标题栏 z-30 层叠上下文）
    expect(document.querySelector('[data-testid="search-panel"]')).not.toBeNull();

    await button.trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="titlebar-search"]').attributes("aria-expanded")).toBe("false");
    wrapper.unmount();
  });

  it("Ctrl+K 开合；Esc 关闭", async () => {
    const wrapper = await mountTitlebar();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await flushPromises();
    expect(wrapper.get('[data-testid="titlebar-search"]').attributes("aria-expanded")).toBe("true");

    // Esc 由 Popover 的 DismissableLayer 处理（此前是面板自挂的 window 监听）
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.get('[data-testid="titlebar-search"]').attributes("aria-expanded")).toBe("false");
    wrapper.unmount();
  });
});
