/**
 * 文件树 store：数据源选择（disk / vfs 回落）、绑定文件夹解析、懒加载展开、单目录失败不炸整棵树。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type * as GreyWorkCore from "@greywork/core";
const h = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  listDir: vi.fn<(path: string) => Promise<{ name: string; kind: "file" | "directory"; origin?: string }[]>>(),
  createFile: vi.fn<(path: string) => Promise<void>>(),
  createDir: vi.fn<(path: string) => Promise<void>>(),
  renamePath: vi.fn<(from: string, to: string) => Promise<void>>(),
  copyPath: vi.fn<(from: string, to: string) => Promise<void>>(),
  deletePath: vi.fn<(path: string) => Promise<void>>(),
  resolveRoot: vi.fn<() => Promise<{ dir: string; bound: boolean }>>(),
  pickFolder: vi.fn<() => Promise<string | null>>(),
  bindFolder: vi.fn<(id: string, folder: string) => Promise<unknown>>(),
}));

vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyWorkCore>()),
  isTauriRuntime: () => h.isTauri(),
}));
vi.mock("@/state/workspaceFiles", () => ({
  listDir: (path: string) => h.listDir(path),
  createFile: (path: string) => h.createFile(path),
  createDir: (path: string) => h.createDir(path),
  renamePath: (from: string, to: string) => h.renamePath(from, to),
  copyPath: (from: string, to: string) => h.copyPath(from, to),
  deletePath: (path: string) => h.deletePath(path),
}));
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
import { usePreviewStore } from "@/stores/preview";
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

  it("Windows 反斜杠路径同样能展开：前缀匹配不依赖分隔符", async () => {
    // Rust canonicalize 在 Windows 上回的是 `\\?\C:\ws\src` 这类反斜杠路径；
    // 之前按 `${node.path}/` 拼前缀，findNode 永远找不到节点，点目录没反应。
    h.isTauri.mockReturnValue(true);
    h.resolveRoot.mockResolvedValue({ dir: "C:\\ws", bound: true });
    h.listDir.mockResolvedValueOnce([{ name: "src", kind: "directory", origin: "C:\\ws\\src" }]);
    const tree = useFileTreeStore();
    await tree.refresh();

    h.listDir.mockResolvedValueOnce([{ name: "index.ts", kind: "file", origin: "C:\\ws\\src\\index.ts" }]);
    await tree.toggle("C:\\ws\\src");

    expect(h.listDir).toHaveBeenCalledTimes(2);
    expect(h.listDir).toHaveBeenLastCalledWith("C:\\ws\\src");
    expect(tree.nodes[0].children?.map((child) => child.name)).toEqual(["index.ts"]);
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
    // 首启不再有种子工作区：先建一个，绑定的落点就是它
    const activeId = workspaceStore.createWorkspace("绑定工作区").id;
    expect(workspaceStore.activeWorkspaceId).toBe(activeId);

    const tree = useFileTreeStore();
    await expect(tree.bindFolder()).resolves.toBe("/data/project");

    // 复用 bindWorkspaceFolder 而不是 setFolder：换绑要连带搬迁既有会话文件
    expect(h.bindFolder).toHaveBeenCalledWith(activeId, "/data/project");
    expect(tree.root).toBe("/data/project");
    expect(tree.bound).toBe(true);
  });
});

/**
 * 增删改的编排：宿主命令 → 重列受影响的目录（**不能**用 refresh()，它会清空展开态）→
 * 同步已打开的预览 tab。宿主那 5 个命令本身的行为在 Rust 侧测（workspace_fs.rs）。
 */
describe("文件树增删改", () => {
  /** 桌面态 + 一层目录（src/ 与 a.md）。 */
  async function diskTree() {
    h.isTauri.mockReturnValue(true);
    h.listDir.mockResolvedValueOnce([entry("src", "directory"), entry("a.md", "file")]);
    const tree = useFileTreeStore();
    await tree.refresh();
    return tree;
  }

  it("reloadDir 只重列目标目录，仍然存在的节点对象被复用（子节点缓存与展开态都留着）", async () => {
    const tree = await diskTree();
    h.listDir.mockResolvedValueOnce([entry("index.ts", "file", "/ws/src")]);
    await tree.toggle("/ws/src");
    const src = tree.nodes.find((node) => node.name === "src")!;
    const loadedChild = src.children![0];

    h.listDir.mockResolvedValueOnce([entry("src", "directory"), entry("a.md", "file"), entry("b.md", "file")]);
    await tree.reloadDir("/ws");

    expect(tree.nodes.map((node) => node.name)).toEqual(["src", "a.md", "b.md"]);
    expect(tree.nodes.find((node) => node.name === "src")).toBe(src);
    expect(tree.isExpanded("/ws/src")).toBe(true);
    expect(tree.nodes.find((node) => node.name === "src")!.children![0]).toBe(loadedChild);
  });

  it("createEntry：建完展开父目录并重列", async () => {
    const tree = await diskTree();
    h.listDir.mockResolvedValueOnce([entry("src", "directory"), entry("a.md", "file"), entry("notes.md", "file")]);
    await tree.createEntry("/ws", "notes.md", "file");

    expect(h.createFile).toHaveBeenCalledWith("/ws/notes.md");
    expect(tree.isExpanded("/ws")).toBe(true);
    expect(tree.nodes.map((node) => node.name)).toContain("notes.md");
  });

  it("createEntry（文件夹）走 createDir", async () => {
    const tree = await diskTree();
    h.listDir.mockResolvedValueOnce([entry("src", "directory"), entry("a.md", "file")]);
    await tree.createEntry("/ws", "assets", "directory");
    expect(h.createDir).toHaveBeenCalledWith("/ws/assets");
  });

  it("renameEntry：改名 + 重列父目录 + 同步已打开的预览 tab", async () => {
    const tree = await diskTree();
    const preview = usePreviewStore();
    const id = preview.open("/ws/a.md", "a.md", "disk");

    h.listDir.mockResolvedValueOnce([entry("src", "directory"), entry("b.md", "file")]);
    await tree.renameEntry("/ws/a.md", "b.md");

    expect(h.renamePath).toHaveBeenCalledWith("/ws/a.md", "/ws/b.md");
    expect(tree.nodes.map((node) => node.name)).toEqual(["src", "b.md"]);
    const tab = preview.tabs.find((candidate) => candidate.id === id);
    expect(tab?.path).toBe("/ws/b.md");
    expect(tab?.name).toBe("b.md");
  });

  it("剪切 + 粘贴 = 移动到目标目录，粘贴后剪贴板清空", async () => {
    const tree = await diskTree();
    tree.cutToClipboard({ path: "/ws/a.md", name: "a.md", kind: "file" });
    expect(tree.clipboard?.mode).toBe("cut");

    // 目标目录先重列，源目录其次
    h.listDir.mockResolvedValueOnce([entry("a.md", "file", "/ws/src")]);
    h.listDir.mockResolvedValueOnce([entry("src", "directory")]);
    await tree.pasteInto("/ws/src");

    expect(h.renamePath).toHaveBeenCalledWith("/ws/a.md", "/ws/src/a.md");
    expect(tree.clipboard).toBeNull();
  });

  it("复制 + 粘贴 = 复制，剪贴板保留（可以连续粘贴）", async () => {
    const tree = await diskTree();
    tree.copyToClipboard({ path: "/ws/a.md", name: "a.md", kind: "file" });

    h.listDir.mockResolvedValueOnce([entry("a.md", "file", "/ws/src")]);
    await tree.pasteInto("/ws/src");

    expect(h.copyPath).toHaveBeenCalledWith("/ws/a.md", "/ws/src/a.md");
    expect(h.renamePath).not.toHaveBeenCalled();
    expect(tree.clipboard?.mode).toBe("copy");
  });

  it("deleteEntry：删掉后重列父目录，并关闭受影响的预览 tab", async () => {
    const tree = await diskTree();
    const preview = usePreviewStore();
    const doomed = preview.open("/ws/a.md", "a.md", "disk");
    const kept = preview.open("/ws/keep.md", "keep.md", "disk");

    h.listDir.mockResolvedValueOnce([entry("src", "directory")]);
    await tree.deleteEntry("/ws/a.md");

    expect(h.deletePath).toHaveBeenCalledWith("/ws/a.md");
    expect(tree.nodes.map((node) => node.name)).toEqual(["src"]);
    expect(preview.tabs.map((tab) => tab.id)).toEqual([kept]);
    expect(preview.tabs.some((tab) => tab.id === doomed)).toBe(false);
  });

  it("vfs 模式：增删改直接拒绝（宿主命令只认授权根）", async () => {
    const tree = useFileTreeStore();
    await tree.refresh(); // 浏览器态 → vfs
    expect(tree.mode).toBe("vfs");

    await expect(tree.createEntry("/x", "a.md", "file")).rejects.toThrow("只有已绑定文件夹");
    await expect(tree.deleteEntry("/x/a.md")).rejects.toThrow("只有已绑定文件夹");
    expect(h.createFile).not.toHaveBeenCalled();
    expect(h.deletePath).not.toHaveBeenCalled();
  });
});
