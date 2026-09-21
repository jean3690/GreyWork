/**
 * 右栏右键菜单：标签条与预览空态是**两个兄弟区域**，各自出各自的条目。
 *
 * 也顺带钉住「区域不嵌套」：标签条 root 与空态 root 互不包含，右键标签时只应开一个菜单。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const openWithSystemApp = vi.fn<(path: string) => Promise<boolean>>();
vi.mock("@/lib/open-external", () => ({
  openWithSystemApp: (path: string) => openWithSystemApp(path),
  resolveTabDiskPath: (tab: { source: string; path: string; diskPath?: string }) =>
    tab.source === "disk" ? tab.path : (tab.diskPath ?? null),
}));

const revealInFolder = vi.fn<(path: string) => Promise<boolean>>();
vi.mock("@/lib/reveal", () => ({ revealInFolder: (path: string) => revealInFolder(path) }));

const copyText = vi.fn<(text: string) => Promise<void>>();
vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

import PreviewSider from "@/features/preview/PreviewSider.vue";
import { usePreviewStore } from "@/stores/preview";
import { i18n } from "@/i18n";

const t = i18n.global.t;

const stubs = {
  PreviewSurface: { template: "<div data-testid='surface-stub' />" },
  WebFetchDialog: { template: "<div data-testid='web-fetch-dialog-stub' />" },
};

function menuItems(): DOMWrapper<Element>[] {
  return [...document.body.querySelectorAll('[data-testid="context-menu-item"]')].map((el) => new DOMWrapper(el));
}

function menuLabels(): string[] {
  return menuItems().map((entry) => entry.text());
}

function menuCount(): number {
  return document.body.querySelectorAll('[data-testid="context-menu-content"]').length;
}

function mountSider(): VueWrapper {
  return mount(PreviewSider, { global: { stubs } });
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  openWithSystemApp.mockReset().mockResolvedValue(true);
  revealInFolder.mockReset().mockResolvedValue(true);
  copyText.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = "";
});

describe("预览标签右键菜单", () => {
  it("磁盘来源标签：激活/重载/系统应用/文件夹/复制路径/关闭三项，且只开一个菜单", async () => {
    const preview = usePreviewStore();
    preview.open("/w/a.md", "a.md", "disk");
    preview.open("/w/b.md", "b.md", "disk");
    const wrapper = mountSider();

    await wrapper.findAll('[data-testid="preview-tab"]')[0].trigger("contextmenu");
    await flushPromises();

    expect(menuCount()).toBe(1);
    expect(menuLabels()).toEqual([
      t("contextMenu.previewTab.activate"),
      t("contextMenu.previewTab.reload"),
      t("contextMenu.previewTab.openExternal"),
      t("contextMenu.previewTab.reveal"),
      t("contextMenu.previewTab.copyPath"),
      t("contextMenu.previewTab.close"),
      t("contextMenu.previewTab.closeOthers"),
      t("contextMenu.previewTab.closeAll"),
    ]);
  });

  it("「关闭其他标签」只留被右键的那个", async () => {
    const preview = usePreviewStore();
    preview.open("/w/a.md", "a.md", "disk");
    preview.open("/w/b.md", "b.md", "disk");
    const wrapper = mountSider();

    await wrapper.findAll('[data-testid="preview-tab"]')[0].trigger("contextmenu");
    await flushPromises();
    await menuItems()[6].trigger("click");
    await flushPromises();

    expect(preview.tabs.map((tab) => tab.path)).toEqual(["/w/a.md"]);
    expect(preview.activeId).toBe(preview.tabs[0]?.id);
  });

  it("vfs 来源标签：没有磁盘孪生路径，缺省系统应用 / 文件夹", async () => {
    const preview = usePreviewStore();
    preview.open("out.md", "out.md", "vfs");
    const wrapper = mountSider();

    await wrapper.get('[data-testid="preview-tab"]').trigger("contextmenu");
    await flushPromises();

    const labels = menuLabels();
    expect(labels).not.toContain(t("contextMenu.previewTab.openExternal"));
    expect(labels).not.toContain(t("contextMenu.previewTab.reveal"));
    expect(labels).toContain(t("contextMenu.previewTab.close"));
  });

  it("「在文件夹中显示」接到 revealInFolder（而不是打开文件）", async () => {
    const preview = usePreviewStore();
    preview.open("/w/a.md", "a.md", "disk");
    const wrapper = mountSider();

    await wrapper.get('[data-testid="preview-tab"]').trigger("contextmenu");
    await flushPromises();
    await menuItems()[3].trigger("click");
    await flushPromises();

    expect(revealInFolder).toHaveBeenCalledWith("/w/a.md");
    expect(openWithSystemApp).not.toHaveBeenCalled();
  });
});

describe("预览空态右键菜单", () => {
  it("无标签：打开文件树 / 抓取网页；点「打开文件树」切到文件区", async () => {
    const wrapper = mountSider();
    await wrapper.get('[data-testid="preview-empty"]').trigger("contextmenu");
    await flushPromises();

    // 注意：右键落在空态 div 上；空态区域不含标签条。
    expect(menuLabels()).toEqual([t("contextMenu.previewEmpty.openFiles"), t("contextMenu.previewEmpty.fetchWeb")]);

    await menuItems()[0].trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true);
  });

  it("空态里右键：命中空态区域，不是标签条", async () => {
    const preview = usePreviewStore();
    preview.open("out.md", "out.md", "vfs");
    preview.closeAll(); // 有历史但已清空：hasTabs 为 false
    const wrapper = mountSider();

    await wrapper.get('[data-testid="preview-empty"]').trigger("contextmenu");
    await flushPromises();
    expect(menuLabels()).toEqual([t("contextMenu.previewEmpty.openFiles"), t("contextMenu.previewEmpty.fetchWeb")]);
  });
});
