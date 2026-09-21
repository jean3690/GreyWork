/**
 * 右键菜单条目构建器（纯逻辑）。
 *
 * 这里盯的是「每个区域给出哪些条目、什么时候禁用/缺省」——菜单本身的打开/定位/portal
 * 由 reka 负责，在 ContextMenuRegion.dom.test.ts 里验。
 *
 * 构建器只读命中元素的 data-*，所以 node 环境用一个假元素（带 dataset）就够，
 * 不必起 happy-dom。
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildActivityTabItems,
  buildComposerItems,
  buildFileTreeItems,
  buildHistoryRowItems,
  buildMessageItems,
  buildPreviewEmptyItems,
  buildPreviewTabItems,
  buildSiderNavItems,
  buildTitlebarItems,
  item,
  separator,
  type ContextMenuItem,
  type ContextTarget,
} from "@/lib/context-menu";

/** 恒等翻译：断言时直接看 key，避免依赖 locale 文件。 */
const t = (key: string) => key;

/** 假命中元素：构建器只用到 dataset。 */
function hit(ctx: string, data: Record<string, string> = {}): ContextTarget {
  return { ctx, el: { dataset: data } as unknown as HTMLElement };
}

/** 条目里的可选项标签（分隔线不算）。 */
function labels(entries: ContextMenuItem[]): string[] {
  return entries.filter((entry) => entry.kind === "item").map((entry) => entry.label);
}

function findItem(entries: ContextMenuItem[], label: string): Extract<ContextMenuItem, { kind: "item" }> {
  const found = entries.find((entry) => entry.kind === "item" && entry.label === label);
  if (!found || found.kind !== "item") throw new Error(`missing menu item: ${label}`);
  return found;
}

describe("item / separator", () => {
  it("item 带上 icon / disabled / destructive，separator 是独立种类", () => {
    const action = vi.fn();
    expect(item("打开", action, { icon: "file", destructive: true })).toMatchObject({
      kind: "item",
      label: "打开",
      icon: "file",
      destructive: true,
    });
    expect(separator()).toEqual({ kind: "separator" });
  });
});

describe("buildFileTreeItems", () => {
  const actions = {
    activate: vi.fn(),
    refresh: vi.fn(),
    canUseDisk: true,
    openExternal: vi.fn(),
    reveal: vi.fn(),
    copyPath: vi.fn(),
  };

  it("磁盘源的文件行：打开 / 系统应用 / 文件夹 / 复制路径 / 刷新", () => {
    const entries = buildFileTreeItems(hit("file-row", { path: "/w/a.ts", kind: "file" }), t, actions);
    expect(labels(entries)).toEqual([
      "contextMenu.fileTree.open",
      "contextMenu.fileTree.openExternal",
      "contextMenu.fileTree.reveal",
      "contextMenu.fileTree.copyPath",
      "contextMenu.fileTree.refresh",
    ]);
    findItem(entries, "contextMenu.fileTree.open").onSelect();
    expect(actions.activate).toHaveBeenCalledWith("/w/a.ts", "file");
    findItem(entries, "contextMenu.fileTree.copyPath").onSelect();
    expect(actions.copyPath).toHaveBeenCalledWith("/w/a.ts");
  });

  it("目录行：系统应用打开禁用（交给文件管理器更自然）", () => {
    const entries = buildFileTreeItems(hit("file-row", { path: "/w/src", kind: "directory" }), t, actions);
    expect(findItem(entries, "contextMenu.fileTree.openExternal").disabled).toBe(true);
    findItem(entries, "contextMenu.fileTree.open").onSelect();
    expect(actions.activate).toHaveBeenCalledWith("/w/src", "directory");
  });

  it("vfs 源：不出现系统应用 / 文件夹两项（没有磁盘孪生路径）", () => {
    const entries = buildFileTreeItems(hit("file-row", { path: "out.md", kind: "file" }), t, {
      ...actions,
      canUseDisk: false,
    });
    expect(labels(entries)).toEqual(["contextMenu.fileTree.open", "contextMenu.fileTree.copyPath", "contextMenu.fileTree.refresh"]);
  });

  it("空白处只给刷新", () => {
    expect(labels(buildFileTreeItems(null, t, actions))).toEqual(["contextMenu.fileTree.refresh"]);
  });
});

describe("buildPreviewTabItems", () => {
  function actions(overrides: Partial<Parameters<typeof buildPreviewTabItems>[2]> = {}) {
    return {
      activate: vi.fn(),
      reload: vi.fn(),
      close: vi.fn(),
      closeOthers: vi.fn(),
      closeAll: vi.fn(),
      copyPath: vi.fn(),
      openExternal: vi.fn(),
      reveal: vi.fn(),
      diskPath: () => null as string | null,
      displayPath: () => "vfs/out.md",
      hasMultiple: true,
      ...overrides,
    };
  }

  it("命中标签：有磁盘路径时含系统应用 / 文件夹；关闭三项都在", () => {
    const ctx = actions({ diskPath: () => "/w/out.md", displayPath: () => "/w/out.md" });
    const entries = buildPreviewTabItems(hit("preview-tab", { tabId: "t1" }), t, ctx);
    expect(labels(entries)).toEqual([
      "contextMenu.previewTab.activate",
      "contextMenu.previewTab.reload",
      "contextMenu.previewTab.openExternal",
      "contextMenu.previewTab.reveal",
      "contextMenu.previewTab.copyPath",
      "contextMenu.previewTab.close",
      "contextMenu.previewTab.closeOthers",
      "contextMenu.previewTab.closeAll",
    ]);
    findItem(entries, "contextMenu.previewTab.copyPath").onSelect();
    expect(ctx.copyPath).toHaveBeenCalledWith("/w/out.md");
    findItem(entries, "contextMenu.previewTab.reveal").onSelect();
    expect(ctx.reveal).toHaveBeenCalledWith("/w/out.md");
  });

  it("纯内存产物：无磁盘路径则缺省系统应用 / 文件夹", () => {
    const entries = buildPreviewTabItems(hit("preview-tab", { tabId: "t1" }), t, actions());
    expect(labels(entries)).not.toContain("contextMenu.previewTab.openExternal");
    expect(labels(entries)).not.toContain("contextMenu.previewTab.reveal");
  });

  it("单标签时「关闭其他」禁用；未命中标签返回空表（抑制菜单）", () => {
    const entries = buildPreviewTabItems(hit("preview-tab", { tabId: "t1" }), t, actions({ hasMultiple: false }));
    expect(findItem(entries, "contextMenu.previewTab.closeOthers").disabled).toBe(true);
    expect(buildPreviewTabItems(null, t, actions())).toEqual([]);
    // 命中但拿不到 tabId（理论上不该发生）：也返回空表，避免对空 id 操作。
    expect(buildPreviewTabItems(hit("preview-tab", {}), t, actions())).toEqual([]);
  });
});

describe("buildPreviewEmptyItems", () => {
  const actions = { openFiles: vi.fn(), fetchWeb: vi.fn(), closeAll: vi.fn(), hasTabs: false };

  it("无标签：只有打开文件树 / 抓取网页", () => {
    expect(labels(buildPreviewEmptyItems(t, actions))).toEqual(["contextMenu.previewEmpty.openFiles", "contextMenu.previewEmpty.fetchWeb"]);
  });

  it("有标签时多一条关闭全部预览", () => {
    expect(labels(buildPreviewEmptyItems(t, { ...actions, hasTabs: true }))).toContain("contextMenu.previewEmpty.closeAll");
  });
});

describe("buildHistoryRowItems", () => {
  it("重命名 / 复制标题 / 删除，删除是破坏性动作", () => {
    const actions = { rename: vi.fn(), copyTitle: vi.fn(), remove: vi.fn() };
    const entries = buildHistoryRowItems(t, actions);
    expect(labels(entries)).toEqual(["contextMenu.historyRow.rename", "contextMenu.historyRow.copyTitle", "contextMenu.historyRow.delete"]);
    expect(findItem(entries, "contextMenu.historyRow.delete").destructive).toBe(true);
    findItem(entries, "contextMenu.historyRow.delete").onSelect();
    expect(actions.remove).toHaveBeenCalledOnce();
  });
});

describe("buildMessageItems", () => {
  it("有正文：复制正文带上该条内容", () => {
    const copyBody = vi.fn();
    const entries = buildMessageItems("hello", t, { copyBody });
    expect(labels(entries)).toEqual(["contextMenu.message.copyBody"]);
    findItem(entries, "contextMenu.message.copyBody").onSelect();
    expect(copyBody).toHaveBeenCalledWith("hello");
  });

  it("空正文（纯卡片 / 占位消息）：空表 → 抑制本次右键", () => {
    expect(buildMessageItems(null, t, { copyBody: vi.fn() })).toEqual([]);
    expect(buildMessageItems("", t, { copyBody: vi.fn() })).toEqual([]);
  });
});

describe("buildComposerItems", () => {
  it("无选区时剪切 / 复制禁用，粘贴与全选始终可用", () => {
    const entries = buildComposerItems(t, {
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      hasSelection: false,
    });
    expect(findItem(entries, "contextMenu.composer.cut").disabled).toBe(true);
    expect(findItem(entries, "contextMenu.composer.copy").disabled).toBe(true);
    expect(findItem(entries, "contextMenu.composer.paste").disabled).toBeUndefined();
    expect(findItem(entries, "contextMenu.composer.selectAll").disabled).toBeUndefined();
  });
});

describe("buildTitlebarItems", () => {
  it("不可用的面板项禁用；新建对话 / 打开设置接到动作", () => {
    const newChat = vi.fn();
    const entries = buildTitlebarItems(t, {
      toggleSidebar: vi.fn(),
      togglePreview: vi.fn(),
      toggleWorkspace: vi.fn(),
      toggleActivity: vi.fn(),
      newChat,
      openSettings: vi.fn(),
      previewAvailable: false,
      workspaceAvailable: true,
      activityAvailable: false,
    });
    expect(findItem(entries, "contextMenu.titlebar.togglePreview").disabled).toBe(true);
    expect(findItem(entries, "contextMenu.titlebar.toggleActivity").disabled).toBe(true);
    expect(findItem(entries, "contextMenu.titlebar.toggleWorkspace").disabled).toBe(false);
    findItem(entries, "contextMenu.titlebar.newChat").onSelect();
    expect(newChat).toHaveBeenCalledOnce();
  });
});

describe("buildSiderNavItems", () => {
  it("新建对话 / 打开设置 / 折叠侧栏", () => {
    const toggleSidebar = vi.fn();
    const entries = buildSiderNavItems(t, { newChat: vi.fn(), openSettings: vi.fn(), toggleSidebar });
    expect(labels(entries)).toEqual([
      "contextMenu.siderNav.newChat",
      "contextMenu.siderNav.openSettings",
      "contextMenu.siderNav.collapseSidebar",
    ]);
    findItem(entries, "contextMenu.siderNav.collapseSidebar").onSelect();
    expect(toggleSidebar).toHaveBeenCalledOnce();
  });
});

describe("buildActivityTabItems", () => {
  it("命中标签：切换 + 收起；空白处只有收起", () => {
    const activate = vi.fn();
    const collapse = vi.fn();
    const withTab = buildActivityTabItems(hit("activity-tab", { tabId: "artifacts" }), t, { activate, collapse });
    expect(labels(withTab)).toEqual(["contextMenu.activityTab.activate", "contextMenu.activityTab.collapse"]);
    findItem(withTab, "contextMenu.activityTab.activate").onSelect();
    expect(activate).toHaveBeenCalledWith("artifacts");

    const blank = buildActivityTabItems(null, t, { activate, collapse });
    expect(labels(blank)).toEqual(["contextMenu.activityTab.collapse"]);
  });
});
