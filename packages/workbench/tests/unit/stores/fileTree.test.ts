/**
 * 文件树 store：数据源选择（disk / vfs 回落）、绑定文件夹解析、懒加载展开、单目录失败不炸整棵树。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type * as GreyWorkCore from "@greywork/core";
const h = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  listDir: vi.fn<(path: string) => Promise<{ name: string; kind: "file" | "directory"; origin?: string }[]>>(),
  resolveRoot: vi.fn<() => Promise<{ dir: string; bound: boolean }>>(),
  pickFolder: vi.fn<() => Promise<string | null>>(),
  bindFolder: vi.fn<(id: string, folder: string) => Promise<unknown>>(),
}));

vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyWorkCore>()),
  isTauriRuntime: () => h.isTauri(),
}));
vi.mock("@/state/workspaceFiles", () => ({ listDir: (path: string) => h.listDir(path) }));
vi.mock("@/lib/workspace-dir", () => ({ resolveWorkspaceRoot: () => h.resolveRoot() }));
vi.mock("@/lib/workspace-picker", () => ({ pickWorkspaceFolder: () => h.pickFolder() }));
vi.mock("@/lib/workspace-bind", () => ({
  bindWorkspaceFolder: (id: string, folder: string) => h.bindFolder(id, folder),
}));
// 这两个只在 boundFolder 计算属性里用到；不 mock 会顺带构造 session store 并去打 Tauri
// 通道（node 环境无 window），给用例刷出一堆与文件树无关的降级日志。
vi.mock("@/lib/conversation-folder", () => ({ activeConversationFolder: () => null }));
vi.mock("@/lib/artifact-dir", () => ({ activeWorkspaceFolder: () => null }));

import { useFileTreeStore } from "@/stores/fileTree";
import { useWorkspaceStore } from "@/stores/workspace";

const entry = (name: string, kind: "file" | "directory", parent = "/ws") => ({
  name,
  kind,
  origin: `${parent}/${name}`,
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.isTauri.mockReturnValue(false);
  h.resolveRoot.mockResolvedValue({ dir: "/ws", bound: true });
  h.pickFolder.mockResolvedValue(null);
  h.bindFolder.mockResolvedValue({ moved: 0, missing: [] });
  h.listDir.mockResolvedValue([]);
});

describe("数据源选择", () => {
  it("浏览器态回落 vfs：不去 listDir，节点来自内存文件系统的种子路径", async () => {
    const tree = useFileTreeStore();
    await tree.refresh();

    expect(tree.mode).toBe("vfs");
    expect(tree.root).toBe("");
    expect(h.listDir).not.toHaveBeenCalled();
    // 种子里有 reports/城市态势报告.md，所以顶层至少有 reports 这个目录
    expect(tree.nodes.some((node) => node.kind === "directory" && node.name === "reports")).toBe(true);
    expect(tree.error).toBeNull();
  });

  it("桌面态载入真实目录第一层，目录排在文件前", async () => {
    h.isTauri.mockReturnValue(true);
    h.listDir.mockResolvedValue([entry("b.md", "file"), entry("src", "directory"), entry("a.md", "file")]);

    const tree = useFileTreeStore();
    await tree.refresh();

    expect(tree.mode).toBe("disk");
    expect(tree.root).toBe("/ws");
    expect(tree.nodes.map((node) => node.name)).toEqual(["src", "a.md", "b.md"]);
    expect(tree.nodes[0].path).toBe("/ws/src");
  });

  it("根目录读失败：报错文案可见，同时回落 vfs 让面板仍有内容", async () => {
    h.isTauri.mockReturnValue(true);
    h.listDir.mockRejectedValue(new Error("打开目录失败: permission denied"));

    const tree = useFileTreeStore();
    await tree.refresh();

    expect(tree.mode).toBe("vfs");
    expect(tree.error).toContain("permission denied");
    expect(tree.nodes.length).toBeGreaterThan(0);
  });
});

describe("展开与懒加载", () => {
  it("首次展开才 listDir，再次展开复用已加载的子节点", async () => {
    h.isTauri.mockReturnValue(true);
    h.listDir.mockResolvedValueOnce([entry("src", "directory")]);
    const tree = useFileTreeStore();
    await tree.refresh();
    expect(h.listDir).toHaveBeenCalledTimes(1);

    h.listDir.mockResolvedValueOnce([entry("index.ts", "file", "/ws/src")]);
    await tree.toggle("/ws/src");
    expect(h.listDir).toHaveBeenCalledTimes(2);
    expect(h.listDir).toHaveBeenLastCalledWith("/ws/src");
    expect(tree.isExpanded("/ws/src")).toBe(true);
    expect(tree.nodes[0].children?.map((child) => child.name)).toEqual(["index.ts"]);

    // 折叠再展开：不该再读一次盘
    await tree.toggle("/ws/src");
    expect(tree.isExpanded("/ws/src")).toBe(false);
    await tree.toggle("/ws/src");
    expect(tree.isExpanded("/ws/src")).toBe(true);
    expect(h.listDir).toHaveBeenCalledTimes(2);
  });

  it("vfs 模式下展开只切状态，不碰磁盘", async () => {
    const tree = useFileTreeStore();
    await tree.refresh();
    await tree.toggle("reports");
    expect(tree.isExpanded("reports")).toBe(true);
    expect(h.listDir).not.toHaveBeenCalled();
  });

  it("单个目录读失败：标成空目录并收起，其余节点不受影响", async () => {
    h.isTauri.mockReturnValue(true);
    h.listDir.mockResolvedValueOnce([entry("locked", "directory"), entry("a.md", "file")]);
    const tree = useFileTreeStore();
    await tree.refresh();

    h.listDir.mockRejectedValueOnce(new Error("打开目录失败: EACCES"));
    await tree.toggle("/ws/locked");

    expect(tree.isExpanded("/ws/locked")).toBe(false);
    expect(tree.error).toContain("EACCES");
    expect(tree.nodes.map((node) => node.name)).toEqual(["locked", "a.md"]);
  });

  it("对文件调 toggle 不会去 listDir（只有目录可展开）", async () => {
    h.isTauri.mockReturnValue(true);
    h.listDir.mockResolvedValueOnce([entry("a.md", "file")]);
    const tree = useFileTreeStore();
    await tree.refresh();

    await tree.toggle("/ws/a.md");
    expect(h.listDir).toHaveBeenCalledTimes(1);
  });
});

describe("工作区文件夹绑定", () => {
  it("兜底目录标记为未绑定：界面据此提示「这不是你的项目目录」", async () => {
    h.isTauri.mockReturnValue(true);
    h.resolveRoot.mockResolvedValue({ dir: "/home/jean", bound: false });

    const tree = useFileTreeStore();
    await tree.refresh();

    expect(tree.mode).toBe("disk");
    expect(tree.root).toBe("/home/jean");
    expect(tree.bound).toBe(false);
  });

  it("用户在选择框里取消：不绑定、不重载", async () => {
    h.isTauri.mockReturnValue(true);
    const tree = useFileTreeStore();
    await tree.refresh();
    const callsBefore = h.listDir.mock.calls.length;

    await expect(tree.bindFolder()).resolves.toBeNull();

    expect(h.bindFolder).not.toHaveBeenCalled();
    expect(h.listDir).toHaveBeenCalledTimes(callsBefore);
  });

  it("选中文件夹：绑到当前激活工作区并重载树", async () => {
    h.isTauri.mockReturnValue(true);
    h.pickFolder.mockResolvedValue("/data/project");
    h.resolveRoot.mockResolvedValue({ dir: "/data/project", bound: true });

    const workspaceStore = useWorkspaceStore();
    const activeId = workspaceStore.activeWorkspaceId;
    expect(activeId).toBeTruthy();

    const tree = useFileTreeStore();
    await expect(tree.bindFolder()).resolves.toBe("/data/project");

    // 复用 bindWorkspaceFolder 而不是 setFolder：换绑要连带搬迁既有会话文件
    expect(h.bindFolder).toHaveBeenCalledWith(activeId, "/data/project");
    expect(tree.root).toBe("/data/project");
    expect(tree.bound).toBe(true);
  });
});
