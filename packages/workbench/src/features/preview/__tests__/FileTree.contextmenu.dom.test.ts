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
  clipboard: null as { path: string; name: string; kind: "file" | "directory"; mode: "copy" | "cut" } | null,
  refresh: vi.fn(),
  bindFolder: vi.fn(),
  toggle: vi.fn(),
  isExpanded: () => true,
  isLoading: () => false,
  createEntry: vi.fn(),
  renameEntry: vi.fn(),
  pasteInto: vi.fn(),
  deleteEntry: vi.fn(),
  copyToClipboard: vi.fn(),
  cutToClipboard: vi.fn(),
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
  treeStub.createEntry.mockReset();
  treeStub.renameEntry.mockReset();
  treeStub.pasteInto.mockReset();
  treeStub.deleteEntry.mockReset();
  treeStub.copyToClipboard.mockReset();
  treeStub.cutToClipboard.mockReset();
  treeStub.clipboard = null;
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

  it("磁盘源的文件行：多出「用系统应用打开 / 在文件夹中显示」与增删改，前两项接到对应工具函数", async () => {
    treeStub.mode = "disk";
    treeStub.nodes = [{ name: "a.ts", path: "/w/a.ts", kind: "file" }];
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();

    expect(menuLabels()).toEqual([
      t("contextMenu.fileTree.open"),
      t("contextMenu.fileTree.openExternal"),
      t("contextMenu.fileTree.reveal"),
      t("contextMenu.fileTree.createFile"),
      t("contextMenu.fileTree.createFolder"),
      t("contextMenu.fileTree.paste"),
      t("contextMenu.fileTree.rename"),
      t("contextMenu.fileTree.copy"),
      t("contextMenu.fileTree.cut"),
      t("contextMenu.fileTree.delete"),
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

  it("磁盘源的目录行：「复制」把条目（含 name）交给剪贴板", async () => {
    treeStub.mode = "disk";
    treeStub.nodes = [{ name: "src", path: "/w/src", kind: "directory" }];
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();

    const copyIndex = menuLabels().indexOf(t("contextMenu.fileTree.copy"));
    await menuItems()[copyIndex].trigger("click");
    await flushPromises();
    expect(treeStub.copyToClipboard).toHaveBeenCalledWith({ path: "/w/src", name: "src", kind: "directory" });
  });

  it("磁盘源：「新建文件」打开对话框并把目标目录带过去", async () => {
    treeStub.mode = "disk";
    treeStub.nodes = [{ name: "src", path: "/w/src", kind: "directory" }];
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();

    const index = menuLabels().indexOf(t("contextMenu.fileTree.createFile"));
    await menuItems()[index].trigger("click");
    await flushPromises();

    // 弹层 Portal 到 body，够不到 wrapper
    expect(document.body.querySelector('[data-testid="new-entry-name"]')).not.toBeNull();
    expect(document.body.textContent).toContain("/w/src");

    // 填入名字提交 → 走 store.createEntry(dir, name, "file")
    const input = document.body.querySelector<HTMLInputElement>('[data-testid="new-entry-name"]')!;
    input.value = "notes.md";
    input.dispatchEvent(new Event("input"));
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>('[data-testid="new-entry-submit"]')!.click();
    await flushPromises();
    expect(treeStub.createEntry).toHaveBeenCalledWith("/w/src", "notes.md", "file");
  });

  it("磁盘源：「重命名」把该行换成输入框，提交后改名", async () => {
    treeStub.mode = "disk";
    treeStub.nodes = [{ name: "a.ts", path: "/w/a.ts", kind: "file" }];
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();

    const index = menuLabels().indexOf(t("contextMenu.fileTree.rename"));
    await menuItems()[index].trigger("click");
    await flushPromises();

    const input = wrapper.get('[data-testid="file-tree-rename"]');
    expect((input.element as HTMLInputElement).value).toBe("a.ts");
    // 整行替换：按钮让位给 input，且 input 必须锁在 26px 行高内（虚拟列表按恒高布局）
    expect(wrapper.find('[data-testid="file-tree-row"]').exists()).toBe(false);
    expect(input.classes()).toContain("h-[26px]");
    // data-ctx 挂在行外层，改名期间右键仍能命中同一行
    expect(wrapper.get('[data-ctx="file-row"]').attributes("data-path")).toBe("/w/a.ts");

    await input.setValue("b.ts");
    await input.trigger("keydown.enter");
    await flushPromises();
    expect(treeStub.renameEntry).toHaveBeenCalledWith("/w/a.ts", "b.ts");
  });

  it("磁盘源：「删除」弹确认，确认后才真的删", async () => {
    treeStub.mode = "disk";
    treeStub.nodes = [{ name: "a.ts", path: "/w/a.ts", kind: "file" }];
    const wrapper = mount(FileTree);
    await wrapper.get('[data-testid="file-tree-row"]').trigger("contextmenu");
    await flushPromises();

    const index = menuLabels().indexOf(t("contextMenu.fileTree.delete"));
    await menuItems()[index].trigger("click");
    await flushPromises();

    const dialog = document.body.querySelector('[data-slot="alert-dialog-content"]');
    expect(dialog?.textContent).toContain(t("preview.fileTree.deleteTitle", { name: "a.ts" }));
    expect(treeStub.deleteEntry).not.toHaveBeenCalled();

    // 弹层按钮顺序：[取消, 确认]
    [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="alert-dialog-content"] button')][1].click();
    await flushPromises();
    expect(treeStub.deleteEntry).toHaveBeenCalledWith("/w/a.ts");
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
