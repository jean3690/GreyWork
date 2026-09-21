/**
 * 文件树右键菜单：行 vs 空白两套条目、磁盘源才有的「系统应用 / 在文件夹中显示」、
 * 以及各动作是否接到真实的 store / 工具函数上。
 *
 * fileTree store 用桩：真 store 的 disk 节点不对外暴露，无法在测试里铺数据。
 * 桩只提供组件实际读的字段，mode 可在 vfs / disk 之间切换以覆盖两条分支。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const treeStub = {
  mode: "vfs" as "vfs" | "disk",
  root: "/w",
  bound: true,
  nodes: [] as { name: string; path: string; kind: "file" | "directory"; children?: unknown[] }[],
  error: null as string | null,
  loadingRoot: false,
  refresh: vi.fn(),
  bindFolder: vi.fn(),
  toggle: vi.fn(),
  isExpanded: () => true,
  isLoading: () => false,
};
vi.mock("@/stores/fileTree", () => ({ useFileTreeStore: () => treeStub }));

const openWithSystemApp = vi.fn<(path: string) => Promise<boolean>>();
vi.mock("@/lib/open-external", () => ({ openWithSystemApp: (path: string) => openWithSystemApp(path) }));

const revealInFolder = vi.fn<(path: string) => Promise<boolean>>();
vi.mock("@/lib/reveal", () => ({ revealInFolder: (path: string) => revealInFolder(path) }));

const copyText = vi.fn<(text: string) => Promise<void>>();
vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

import FileTree from "@/features/preview/FileTree.vue";
import { usePreviewStore } from "@/stores/preview";
import { useNoticeStore } from "@/stores/notice";
import { i18n } from "@/i18n";

const t = i18n.global.t;

function menuItems(): DOMWrapper<Element>[] {
  return [...document.body.querySelectorAll('[data-testid="context-menu-item"]')].map((el) => new DOMWrapper(el));
}

function menuLabels(): string[] {
  return menuItems().map((entry) => entry.text());
}

function menuExists(): boolean {
  return document.body.querySelector('[data-testid="context-menu-content"]') !== null;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  treeStub.mode = "vfs";
  treeStub.nodes = [
    { name: "out.md", path: "out.md", kind: "file" },
    { name: "src", path: "src", kind: "directory" },
  ];
  treeStub.refresh.mockReset();
  treeStub.toggle.mockReset();
  openWithSystemApp.mockReset().mockResolvedValue(true);
  revealInFolder.mockReset().mockResolvedValue(true);
  copyText.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = "";
});

describe("文件树右键菜单", () => {
  it("vfs 行：打开 / 复制路径 / 刷新，不含磁盘专属项", async () => {
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();

    expect(menuExists()).toBe(true);
    expect(menuLabels()).toEqual([t("contextMenu.fileTree.open"), t("contextMenu.fileTree.copyPath"), t("contextMenu.fileTree.refresh")]);
  });

  it("点「打开」：文件进预览面板", async () => {
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();

    await menuItems()[0].trigger("click");
    await flushPromises();

    const preview = usePreviewStore();
    expect(preview.tabs.map((tab) => tab.path)).toEqual(["out.md"]);
    expect(preview.collapsed).toBe(false);
  });

  it("点「复制路径」写入剪贴板", async () => {
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();

    await menuItems()[1].trigger("click");
    await flushPromises();
    expect(copyText).toHaveBeenCalledWith("out.md");
  });

  it("空白处：只有「刷新文件树」，点了走 store.refresh", async () => {
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree"]').trigger("contextmenu");
    await flushPromises();

    expect(menuLabels()).toEqual([t("contextMenu.fileTree.refresh")]);
    await menuItems()[0].trigger("click");
    await flushPromises();
    expect(treeStub.refresh).toHaveBeenCalled();
  });

  it("磁盘源的文件行：多出「用系统应用打开 / 在文件夹中显示」，分别接到对应工具函数", async () => {
    treeStub.mode = "disk";
    treeStub.nodes = [{ name: "a.ts", path: "/w/a.ts", kind: "file" }];
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();

    expect(menuLabels()).toEqual([
      t("contextMenu.fileTree.open"),
      t("contextMenu.fileTree.openExternal"),
      t("contextMenu.fileTree.reveal"),
      t("contextMenu.fileTree.copyPath"),
      t("contextMenu.fileTree.refresh"),
    ]);

    await menuItems()[1].trigger("click");
    await flushPromises();
    expect(openWithSystemApp).toHaveBeenCalledWith("/w/a.ts");

    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();
    await menuItems()[2].trigger("click");
    await flushPromises();
    expect(revealInFolder).toHaveBeenCalledWith("/w/a.ts");
  });

  it("磁盘源目录行：「用系统应用打开」禁用", async () => {
    treeStub.mode = "disk";
    treeStub.nodes = [{ name: "src", path: "/w/src", kind: "directory" }];
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();

    expect(menuItems()[1].attributes("data-disabled")).toBeDefined();
    await menuItems()[1].trigger("click");
    await flushPromises();
    expect(openWithSystemApp).not.toHaveBeenCalled();
  });

  it("系统应用打开失败：给一条可见提示而不是静默", async () => {
    treeStub.mode = "disk";
    treeStub.nodes = [{ name: "a.ts", path: "/w/a.ts", kind: "file" }];
    openWithSystemApp.mockResolvedValue(false);
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();
    await menuItems()[1].trigger("click");
    await flushPromises();

    expect(useNoticeStore().list.some((notice) => notice.title === t("fileOp.openFailed"))).toBe(true);
  });
});
