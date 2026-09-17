/**
 * 右栏外壳的可观察行为：折叠即宽度归零且 aria-hidden、tab 增删与焦点、
 * 关掉最后一个 tab 自动折叠、拖拽把手仅在展开时存在。
 *
 * `PreviewSurface` 被 stub 掉：它按 kind 动态 import 到 Univer / pdf.js，
 * 在 happy-dom 里既跑不起来也不是本用例要验的东西。
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import PreviewSider from "@/features/preview/PreviewSider.vue";
import { useNoticeStore } from "@/stores/notice";
import { usePreviewStore } from "@/stores/preview";

const invokeMock = vi.mocked(invoke);

const stubs = {
  PreviewSurface: { template: "<div data-testid='surface-stub' />" },
  // 空态「抓取网页」用例只验入口接通，reka-ui 弹层在 happy-dom 里不是要验的东西
  WebFetchDialog: { template: "<div data-testid='web-fetch-dialog-stub' />" },
};

function mountSider(): VueWrapper {
  return mount(PreviewSider, { global: { stubs } });
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("PreviewSider", () => {
  it("默认折叠：宽度 0、带 aria-hidden、没有拖拽把手", () => {
    const wrapper = mountSider();
    const aside = wrapper.get('[data-testid="preview-sider"]');
    expect(aside.attributes("style")).toContain("width: 0px");
    expect(aside.attributes("aria-hidden")).toBe("true");
    expect(wrapper.find('[data-testid="preview-resize-handle"]').exists()).toBe(false);
  });

  it("打开一个路径：出现一个 tab、面板展开、把手可见", async () => {
    const wrapper = mountSider();
    usePreviewStore().open("reports/a.md");
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('[data-testid="preview-tab"]')).toHaveLength(1);
    const aside = wrapper.get('[data-testid="preview-sider"]');
    expect(aside.attributes("aria-hidden")).toBeUndefined();
    expect(aside.attributes("style")).not.toContain("width: 0px");
    expect(wrapper.find('[data-testid="preview-resize-handle"]').exists()).toBe(true);
  });

  it("同路径重复打开不新增 tab", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("reports/a.md");
    preview.open("reports/a.md");
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="preview-tab"]')).toHaveLength(1);
  });

  it("打开第二个路径：两个 tab，后者激活", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("reports/a.md");
    const second = preview.open("data/b.csv");
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('[data-testid="preview-tab"]')).toHaveLength(2);
    expect(preview.activeId).toBe(second);
    expect(preview.activeTab?.name).toBe("b.csv");
  });

  it("点 tab 内的关闭键移除该 tab", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("reports/a.md");
    preview.open("data/b.csv");
    await wrapper.vm.$nextTick();

    await wrapper.findAll('[data-testid="preview-tab-close"]')[0].trigger("click");
    expect(wrapper.findAll('[data-testid="preview-tab"]')).toHaveLength(1);
    expect(preview.tabs.map((tab) => tab.path)).toEqual(["data/b.csv"]);
  });

  it("关掉最后一个 tab 后面板折叠并显示空态", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("reports/a.md");
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="preview-tab-close"]').trigger("click");
    expect(preview.collapsed).toBe(true);
    expect(wrapper.get('[data-testid="preview-sider"]').attributes("style")).toContain("width: 0px");
    expect(wrapper.text()).toContain("暂无预览内容");
  });

  it("折叠按钮把面板收起但不清空 tab（展开后还在原处）", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("reports/a.md");
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="preview-collapse"]').trigger("click");
    expect(preview.collapsed).toBe(true);
    expect(preview.tabs).toHaveLength(1);
  });

  it("重载按钮自增当前 tab 的 revision", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("reports/a.md");
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="preview-reload"]').trigger("click");
    expect(preview.activeTab?.revision).toBe(1);
  });

  it("单个 tab 时不显示「关闭全部」；多个时显示且能清空", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("reports/a.md");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="preview-close-all"]').exists()).toBe(false);

    preview.open("data/b.csv");
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-testid="preview-close-all"]').trigger("click");
    expect(preview.tabs).toHaveLength(0);
  });
});

describe("PreviewSider tab 交互（中键关闭 / 拖拽排序）", () => {
  it("中键（auxclick button=1）关闭 tab", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("reports/a.md");
    preview.open("data/b.csv");
    await wrapper.vm.$nextTick();

    await wrapper.findAll('[data-testid="preview-tab"]')[0].trigger("auxclick", { button: 1 });
    expect(preview.tabs.map((tab) => tab.path)).toEqual(["data/b.csv"]);
  });

  it("左键 auxclick 不误关（只有中键语义）", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("reports/a.md");
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="preview-tab"]').trigger("auxclick", { button: 0 });
    expect(preview.tabs).toHaveLength(1);
  });

  it("drop 到目标 tab 的下标触发重排", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("reports/a.md");
    preview.open("data/b.csv");
    await wrapper.vm.$nextTick();

    // 模拟拖拽：dragstart 记下被拖 tab，drop 落在下标 1
    const tabs = wrapper.findAll('[data-testid="preview-tab"]');
    await tabs[0].trigger("dragstart", { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
    await tabs[1].trigger("drop", { dataTransfer: {} });
    expect(preview.tabs.map((tab) => tab.path)).toEqual(["data/b.csv", "reports/a.md"]);
    // 重排不抢焦点
    expect(preview.activeTab?.path).toBe("data/b.csv");
  });
});

describe("PreviewSider 空态引导", () => {
  it("「打开文件树」切到文件区", async () => {
    const wrapper = mountSider();
    await wrapper.get('[data-testid="preview-empty-files"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true);
  });

  it("「抓取网页」拉起抓取对话框", async () => {
    const wrapper = mountSider();
    expect(wrapper.find('[data-testid="web-fetch-dialog-stub"]').exists()).toBe(false);
    await wrapper.get('[data-testid="preview-empty-fetch"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="web-fetch-dialog-stub"]').exists()).toBe(true);
  });
});

describe("PreviewSider「用系统应用打开」", () => {
  /** 桌面态标记：`isTauriRuntime()` 认 window 上的 `__TAURI_INTERNALS__`。 */
  function stubTauriRuntime(): void {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    invokeMock.mockReset();
  });

  it("浏览器态不显示：没有磁盘通道，按钮留着只会点了没反应", async () => {
    const wrapper = mountSider();
    usePreviewStore().open("/data/a.xlsx", "a.xlsx", "disk");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="preview-open-external"]').exists()).toBe(false);
  });

  it("磁盘源 tab：出现按钮，点击以 open_path 调宿主", async () => {
    stubTauriRuntime();
    invokeMock.mockResolvedValue(undefined);
    const wrapper = mountSider();
    usePreviewStore().open("/data/a.xlsx", "a.xlsx", "disk");
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="preview-open-external"]').trigger("click");
    await flushPromises();
    expect(invokeMock).toHaveBeenCalledWith("open_path", { path: "/data/a.xlsx" });
  });

  it("vfs 产物：落盘路径挂上之前不显示，挂上之后就出现", async () => {
    stubTauriRuntime();
    const wrapper = mountSider();
    const preview = usePreviewStore();
    preview.open("artifacts/a.xlsx", "a.xlsx");
    await wrapper.vm.$nextTick();
    // 纯内存产物没有系统程序可开
    expect(wrapper.find('[data-testid="preview-open-external"]').exists()).toBe(false);

    preview.attachDiskPath("artifacts/a.xlsx", "/home/u/.greyWork/artifacts/a.xlsx");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="preview-open-external"]').exists()).toBe(true);
  });

  it("宿主打开失败时弹提醒而不是静默", async () => {
    stubTauriRuntime();
    invokeMock.mockRejectedValue(new Error("路径不存在"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wrapper = mountSider();
    usePreviewStore().open("/data/a.xlsx", "a.xlsx", "disk");
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="preview-open-external"]').trigger("click");
    await flushPromises();
    expect(useNoticeStore().list.some((notice) => notice.title === "无法用系统应用打开")).toBe(true);
  });
});

describe("PreviewSider 区段切换", () => {
  it("默认停在预览区，文件树不挂载", () => {
    const wrapper = mountSider();
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="preview-section-preview"]').attributes("aria-current")).toBe("true");
  });

  it("点「文件」切到文件树；浏览器态走 VFS 模式，列出内存文件系统的内容", async () => {
    const wrapper = mountSider();
    await wrapper.get('[data-testid="preview-section-files"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true);
    const rows = wrapper.findAll('[data-testid="file-tree-row"]');
    expect(rows.length).toBeGreaterThan(0);
    // 内存文件系统而非磁盘：提示条要说清楚，否则用户会以为看到的是工作区
    expect(wrapper.text()).toContain("内存文件系统");
  });

  it("点树里的文件：开一个 vfs 来源的 tab，并自动跳回预览区", async () => {
    const wrapper = mountSider();
    const preview = usePreviewStore();
    await wrapper.get('[data-testid="preview-section-files"]').trigger("click");
    await flushPromises();

    // 展开 reports 目录后点里面的 md 文件
    const reports = wrapper.findAll('[data-testid="file-tree-row"]').find((row) => row.text().includes("reports"));
    await reports?.trigger("click");
    await flushPromises();
    const file = wrapper.findAll('[data-testid="file-tree-row"]').find((row) => row.text().includes(".md"));
    await file?.trigger("click");
    await flushPromises();

    expect(preview.tabs).toHaveLength(1);
    expect(preview.tabs[0].source).toBe("vfs");
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="preview-tab"]')).toHaveLength(1);
  });
});
