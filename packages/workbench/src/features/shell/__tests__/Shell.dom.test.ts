/**
 * 外壳（Shell）：快捷键全域接线、布局模式联动、设置弹窗事件、裸窗口模式、外观落地与卸载清理。
 * 重子组件全部 stub，路由 / 插件引导 / 远程助手 mock 掉 —— 这里只验壳子自身的接线。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({
  routeMeta: { bare: false },
  push: vi.fn(),
  bootPlugins: vi.fn(),
  remoteInit: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ meta: h.routeMeta }),
  useRouter: () => ({ push: h.push }),
}));
vi.mock("@/plugins/runtime", () => ({ bootPlugins: h.bootPlugins }));
vi.mock("@/stores/remote-assistant", () => ({
  useRemoteAssistantStore: () => ({ init: h.remoteInit }),
}));

import Shell from "@/features/shell/Shell.vue";
import { appEvents } from "@/events";
import { useLayoutStore } from "@/stores/layout";
import { usePreviewStore } from "@/stores/preview";
import { useWorkspacePanelStore } from "@/stores/workspacePanel";
import { registerPreviewSaver } from "@/lib/preview-save";
import { cancelDiscard, pendingDiscard } from "@/lib/preview-edit-guard";
import { ref } from "vue";

const Titlebar = {
  props: ["collapsed", "showSiderToggle"],
  emits: ["toggle-sider"],
  template: `<div data-testid="titlebar" :data-collapsed="collapsed" :data-sider-toggle="showSiderToggle" />`,
};
const SettingsDialog = {
  props: ["open", "section"],
  template: `<div data-testid="settings-dialog" :data-open="open" :data-section="section" />`,
};
const stubs = {
  Titlebar,
  SettingsDialog,
  Sider: true,
  PreviewSider: true,
  WorkspacePanel: true,
  ActivityBand: true,
  WorkspaceOverlayRegions: true,
  NoticeHost: true,
  RouterView: { template: `<div data-testid="router-view-stub" />` },
};

/** 逐个卸载已挂的 Shell：它的 keydown 监听挂在 window 上，不清掉会跨用例叠加触发。 */
const mounted: VueWrapper[] = [];
function mountShell(): VueWrapper {
  const wrapper = mount(Shell, { global: { stubs } });
  mounted.push(wrapper);
  return wrapper;
}

function keydown(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent("keydown", init));
}

/** keydown 是同步派发，但 collapsed 的响应式 flush 走微任务，断言前要让两跳 watcher 落地。 */
async function press(init: KeyboardEventInit): Promise<void> {
  keydown(init);
  await nextTick();
  await nextTick();
}

function titlebar(wrapper: VueWrapper): string | null {
  return wrapper.get('[data-testid="titlebar"]').attributes("data-collapsed") ?? null;
}

beforeEach(() => {
  localStorage.clear();
  h.routeMeta.bare = false;
  h.push.mockReset();
  h.bootPlugins.mockReset().mockResolvedValue(undefined);
  h.remoteInit.mockReset().mockResolvedValue(undefined);
  setActivePinia(createPinia());
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe("Shell", () => {
  it("桌面端：渲染外壳骨架、接收 collapsed 传参、外观并落地 DOM、引导插件", () => {
    const wrapper = mountShell();

    expect(wrapper.find('[data-testid="shell"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="router-view-stub"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="titlebar"]').attributes("data-collapsed")).toBe("false");
    // 桌面端侧栏常驻，开合键交给侧栏顶部的品牌键；标题栏那颗只在移动端渲染
    expect(wrapper.get('[data-testid="titlebar"]').attributes("data-sider-toggle")).toBe("false");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-palette")).toBe("greywork");
    expect(h.bootPlugins).toHaveBeenCalledTimes(1);
    expect(h.remoteInit).toHaveBeenCalledTimes(1);
  });

  it("裸窗口路由（meta.bare）：只渲染 router-view，不出现外壳 chrome", () => {
    h.routeMeta.bare = true;
    const wrapper = mountShell();

    expect(wrapper.find('[data-testid="shell"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="router-view-stub"]').exists()).toBe(true);
  });

  it("Ctrl+N 新对话：createSession 后跳转 /conversation/{id}", () => {
    mountShell();
    const event = new KeyboardEvent("keydown", { key: "n", ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0]).toMatch(/^\/conversation\//);
  });

  it("Ctrl+B 折叠/展开左栏，桌面下回写偏好", async () => {
    const wrapper = mountShell();
    await press({ key: "b", ctrlKey: true });
    expect(titlebar(wrapper)).toBe("true");
    expect(useLayoutStore().sidebarCollapsed).toBe(true);

    await press({ key: "b", ctrlKey: true });
    expect(titlebar(wrapper)).toBe("false");
    expect(useLayoutStore().sidebarCollapsed).toBe(false);
  });

  it("Ctrl+E 拨工作区栏开关（available 时）", async () => {
    mountShell();
    const workspace = useWorkspacePanelStore();
    const before = workspace.collapsed;

    await press({ key: "e", ctrlKey: true });
    expect(workspace.collapsed).toBe(!before);
  });

  it("Ctrl+\\ 拨预览面板开关", async () => {
    mountShell();
    const preview = usePreviewStore();
    const before = preview.collapsed;

    await press({ key: "\\", ctrlKey: true });
    expect(preview.collapsed).toBe(!before);
  });

  it("Ctrl+1..4 布局联动：两个面板一起拨到位", async () => {
    const wrapper = mountShell();
    const preview = usePreviewStore();

    await press({ key: "2", code: "Digit2", ctrlKey: true }); // 对话主导：收预览留导航
    expect(titlebar(wrapper)).toBe("false");
    expect(preview.collapsed).toBe(true);

    await press({ key: "3", code: "Digit3", ctrlKey: true }); // 文档主导：收导航留预览
    expect(titlebar(wrapper)).toBe("true");
    expect(preview.collapsed).toBe(false);

    await press({ key: "4", code: "Digit4", ctrlKey: true }); // 专注：全收
    expect(titlebar(wrapper)).toBe("true");
    expect(preview.collapsed).toBe(true);

    await press({ key: "1", code: "Digit1", ctrlKey: true }); // 三栏：全开
    expect(titlebar(wrapper)).toBe("false");
    expect(preview.collapsed).toBe(false);
  });

  it("窄屏：Ctrl+2 展开抽屉后按 Escape 收起（遮罩的键盘退路）", async () => {
    const wrapper = mountShell();
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(titlebar(wrapper)).toBe("true");
    // 窄屏收起时 Sider 整个不挂载，标题栏那颗是唯一的抽屉入口
    expect(wrapper.get('[data-testid="titlebar"]').attributes("data-sider-toggle")).toBe("true");

    await press({ key: "2", code: "Digit2", ctrlKey: true });
    expect(titlebar(wrapper)).toBe("false");

    await press({ key: "Escape" });
    expect(titlebar(wrapper)).toBe("true");
  });

  it("settings:open 事件总线：指定分区并把弹窗拨开", async () => {
    const wrapper = mountShell();
    expect(wrapper.get('[data-testid="settings-dialog"]').attributes("data-open")).toBe("false");

    appEvents.emit("settings:open", { section: "remote" });
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[data-testid="settings-dialog"]').attributes("data-open")).toBe("true");
    expect(wrapper.get('[data-testid="settings-dialog"]').attributes("data-section")).toBe("remote");
  });

  it("卸载后快捷键监听拆除：不再响应 Ctrl+N", () => {
    const wrapper = mountShell();
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);

    keydown({ key: "n", ctrlKey: true });
    expect(h.push).not.toHaveBeenCalled();
  });
});

/**
 * 窄屏会把右栏整个卸载（模板 `v-if`），而卸载会注销编辑器 saver —— 未保存的改动就此消失。
 * 这组用例守住「先保存再卸载」这条路径，以及它失败 / 被取消 / 中途回桌面时的落点。
 */
describe("Shell 窄屏收拢右栏：先保存再卸载", () => {
  function setWidth(px: number): void {
    Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
  }

  /** 打开一个 tab 并挂一个可控的假 saver；返回 save 的调用计数与手动 resolve 的钩子。 */
  function armDirtyTab(options: { fail?: boolean; manual?: boolean } = {}) {
    const id = usePreviewStore().open("reports/a.md");
    const dirty = ref(true);
    let saves = 0;
    let release: (() => void) | null = null;
    registerPreviewSaver(id, {
      dirty,
      save: async () => {
        saves += 1;
        if (options.manual) await new Promise<void>((resolve) => (release = resolve));
        if (options.fail) throw new Error("写盘失败");
        dirty.value = false;
      },
    });
    return {
      dirty,
      count: () => saves,
      finish: () => release?.(),
    };
  }

  /** 让守卫那串 await 与 Vue 的 watcher 都落地。 */
  async function settle(): Promise<void> {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }

  beforeEach(() => {
    setWidth(1024);
    cancelDiscard();
  });

  afterEach(() => {
    setWidth(1024);
    cancelDiscard();
  });

  it("有脏改动：先保存，成功后才卸载", async () => {
    mountShell();
    const saver = armDirtyTab();
    const preview = usePreviewStore();
    expect(preview.available).toBe(true);

    setWidth(500);
    window.dispatchEvent(new Event("resize"));
    await settle();

    expect(saver.count()).toBe(1);
    expect(saver.dirty.value).toBe(false);
    expect(preview.available).toBe(false);
  });

  it("保存失败：面板留着不卸载，等用户答复", async () => {
    mountShell();
    const saver = armDirtyTab({ fail: true });
    const preview = usePreviewStore();

    setWidth(500);
    window.dispatchEvent(new Event("resize"));
    await settle();

    expect(saver.count()).toBe(1);
    expect(pendingDiscard.value?.failed).toHaveLength(1);
    expect(preview.available).toBe(true);
  });

  it("用户取消：继续留着面板，且不再反复追问", async () => {
    mountShell();
    const saver = armDirtyTab({ fail: true });
    const preview = usePreviewStore();

    setWidth(500);
    window.dispatchEvent(new Event("resize"));
    await settle();
    cancelDiscard();
    await settle();

    expect(preview.available).toBe(true);
    // 再触发一次 resize：不该再发起新一轮 flush
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(saver.count()).toBe(1);
    expect(pendingDiscard.value).toBeNull();
  });

  it("flush 期间拉回桌面：不再卸载面板", async () => {
    mountShell();
    const saver = armDirtyTab({ manual: true });
    const preview = usePreviewStore();

    setWidth(500);
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(saver.count()).toBe(1);

    // 保存还没写完就拉回桌面
    setWidth(1200);
    window.dispatchEvent(new Event("resize"));
    saver.finish();
    await settle();

    expect(preview.available).toBe(true);
  });

  it("没有脏改动：照旧直接卸载，不做无谓的保存", async () => {
    mountShell();
    const preview = usePreviewStore();
    expect(preview.available).toBe(true);

    setWidth(500);
    window.dispatchEvent(new Event("resize"));
    await settle();

    expect(preview.available).toBe(false);
  });
});
