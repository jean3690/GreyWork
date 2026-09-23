import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { basename, isTauriRuntime, joinPath, normalizePath } from "@greywork/core";
import { listDir, copyPath, createDir, createFile, deletePath, renamePath } from "../state/workspaceFiles";
import { resolveWorkspaceRoot } from "../lib/workspace-dir";
import { activeWorkspaceFolder } from "../lib/artifact-dir";
import { activeConversationFolder } from "../lib/conversation-folder";
import { pickWorkspaceFolder } from "../lib/workspace-picker";
import { bindWorkspaceFolder } from "../lib/workspace-bind";
import { buildFileTree, useVfsStore } from "./vfs";
import { usePreviewStore } from "./preview";
import { useWorkspaceStore } from "./workspace";

/**
 * 右栏「文件」区的树。
 *
 * 两种数据源，取决于运行态：
 * - `disk`（Tauri 桌面端）：真实工作区目录，**逐层懒加载**。ACP agent（Codex / Claude Code）
 *   是直接往磁盘写文件的，它们的产出既不进 VFS 也不发 artifact 事件 —— 只有这条通道能看见。
 * - `vfs`（浏览器态 / 未解析出工作区目录）：内存虚拟文件系统，一次性铺开（种子 + 管线产物）。
 *
 * 为什么懒加载而不是一次递归扫：工作区可能是 home 目录，递归一次要走几十万个 inode，
 * 而浅层列目录只花一次 readdir。展开哪层就读哪层，代价与用户意图成正比。
 */
export type FileTreeMode = "disk" | "vfs";

export interface FileTreeNode {
  name: string;
  /** `disk` 模式为绝对路径，`vfs` 模式为 VFS 相对路径。 */
  path: string;
  kind: "file" | "directory";
  /** 目录：`undefined` = 尚未展开过；数组 = 已加载（空数组是「空目录」这个事实）。 */
  children?: FileTreeNode[];
}

/**
 * 应用内剪贴板条目（复制 / 剪切）。
 *
 * **放 store 而不是组件 state**：`FileTree` 在两处挂载（右栏「文件」区段与最右的工作区栏
 * `WorkspacePanel.vue`），组件各自的剪贴板会让「这栏复制、那栏粘贴」直接失效。
 */
export interface ClipboardEntry {
  path: string;
  name: string;
  kind: FileTreeNode["kind"];
  mode: "copy" | "cut";
}

export const useFileTreeStore = defineStore("fileTree", () => {
  const vfsStore = useVfsStore();

  const mode = ref<FileTreeMode>("vfs");
  /** disk 模式的根目录绝对路径；vfs 模式为空串。 */
  const root = ref("");
  /** 是否来自用户绑定目录（false = 设置项/应用私有根兜底，界面应提示绑定）。 */
  const bound = ref(false);
  const diskNodes = ref<FileTreeNode[]>([]);
  /** 已展开的目录路径。展开态与子节点分开存：折叠不丢已加载的内容。 */
  const expanded = ref<Set<string>>(new Set());
  /** 正在加载子节点的目录路径（转圈用）。 */
  const loadingPaths = ref<Set<string>>(new Set());
  const loadingRoot = ref(false);
  const error = ref<string | null>(null);

  /** vfs 模式直接由 VFS 路径清单派生，不需要自己维护 —— 产物写入即出现在树里。 */
  const nodes = computed<FileTreeNode[]>(() => (mode.value === "disk" ? diskNodes.value : buildFileTree(vfsStore.paths)));

  function sortEntries(entries: FileTreeNode[]): FileTreeNode[] {
    return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
  }

  /** 在已加载的树里按路径找节点（逐层下钻，不做全树遍历）。 */
  function findNode(path: string, level = diskNodes.value): FileTreeNode | null {
    const target = normalizePath(path);
    for (const node of level) {
      const nodePath = normalizePath(node.path);
      if (nodePath === target) return node;
      if (node.children && target.startsWith(`${nodePath}/`)) {
        const hit = findNode(path, node.children);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * 解析根目录并载入第一层。
   * 解析失败（无 Tauri / 无法确定目录）不是错误状态，而是降级到 vfs 模式 ——
   * 浏览器里本来就没有磁盘，给个「配置工作区目录」的报错只会让人困惑。
   */
  async function refresh(): Promise<void> {
    error.value = null;
    expanded.value = new Set();
    if (!isTauriRuntime()) {
      mode.value = "vfs";
      root.value = "";
      bound.value = false;
      diskNodes.value = [];
      return;
    }
    loadingRoot.value = true;
    try {
      const resolution = await resolveWorkspaceRoot();
      const entries = await listDir(resolution.dir);
      root.value = resolution.dir;
      bound.value = resolution.bound;
      diskNodes.value = sortEntries(
        entries.map((entry) => ({
          name: entry.name,
          path: entry.origin ?? entry.name,
          kind: entry.kind,
          children: undefined,
        })),
      );
      mode.value = "disk";
    } catch (cause: unknown) {
      // 目录读不出来（权限 / 路径不存在）才是真错误，要显式说；此时仍回落 vfs 让面板有内容。
      mode.value = "vfs";
      root.value = "";
      bound.value = false;
      diskNodes.value = [];
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loadingRoot.value = false;
    }
  }

  /**
   * 选文件夹并绑定到当前工作区，然后重载树。
   *
   * 复用 `bindWorkspaceFolder`（而不是直接 `setFolder`）：换绑要把既有会话文件一并搬到新目录，
   * 那套编排已经在 lib/workspace-bind.ts 里，绕过它会让历史会话留在旧目录成为孤儿。
   * 没有激活工作区时按文件夹名新建一个 —— 用户的意图是「让我看这个文件夹」，
   * 不该先逼他去别处建工作区。
   */
  async function bindFolder(): Promise<string | null> {
    const folder = await pickWorkspaceFolder();
    if (!folder) return null;
    const workspaceStore = useWorkspaceStore();
    const id = workspaceStore.activeWorkspaceId ?? workspaceStore.createWorkspace(basename(folder) || folder, "右栏文件树绑定").id;
    await bindWorkspaceFolder(id, folder);
    await refresh();
    return folder;
  }

  /** 展开/折叠目录；disk 模式下首次展开才去 listDir（已加载过的直接复用）。 */
  async function toggle(path: string): Promise<void> {
    const next = new Set(expanded.value);
    if (next.has(path)) {
      next.delete(path);
      expanded.value = next;
      return;
    }
    next.add(path);
    expanded.value = next;
    if (mode.value !== "disk") return;

    const node = findNode(path);
    if (!node || node.kind !== "directory" || node.children !== undefined) return;

    const loading = new Set(loadingPaths.value);
    loading.add(path);
    loadingPaths.value = loading;
    try {
      const entries = await listDir(path);
      node.children = sortEntries(
        entries.map((entry) => ({
          name: entry.name,
          path: entry.origin ?? joinPath(path, entry.name),
          kind: entry.kind,
        })),
      );
      // 触发响应式：node 是深层对象，直接改 children 不一定被 computed 感知。
      diskNodes.value = [...diskNodes.value];
    } catch (cause: unknown) {
      // 单个目录读失败（常见于 home 下的受限目录）不该炸整棵树：标成空目录并收起。
      node.children = [];
      const collapsed = new Set(expanded.value);
      collapsed.delete(path);
      expanded.value = collapsed;
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      const done = new Set(loadingPaths.value);
      done.delete(path);
      loadingPaths.value = done;
    }
  }

  function isExpanded(path: string): boolean {
    return expanded.value.has(path);
  }

  function isLoading(path: string): boolean {
    return loadingPaths.value.has(path);
  }

  /* ===== 文件树增删改 =====
   * 目标目录与源路径由调用方（菜单 / 行内改名）给出，这里只负责编排：
   * 调宿主 → 重列受影响目录 → 同步已打开的预览 tab。
   * 全部只支持磁盘工作区（vfs 是内存产物视图，宿主那 5 个命令也要求授权根）。
   */

  const clipboard = ref<ClipboardEntry | null>(null);

  function assertDiskMode(): void {
    if (mode.value !== "disk") throw new Error("只有已绑定文件夹的工作区支持文件操作");
  }

  /** 取某目录当前已加载的子节点（根目录不在 diskNodes 里，要特判）。 */
  function childrenOf(dir: string): FileTreeNode[] {
    if (normalizePath(dir) === normalizePath(root.value)) return diskNodes.value;
    return findNode(dir)?.children ?? [];
  }

  /**
   * 重列**单个目录**并就地替换它的子节点，**保留其余部分的展开态**。
   *
   * 增删改之后不能用 `refresh()`：它会把 `expanded` 清空（见上），用户刚整理过的树整棵
   * 折回去。这里还把**仍然存在**的旧节点对象按 path 接回去，于是已展开的子目录连同它们
   * 的子节点缓存都留着 —— 列表里只是多了 / 少了一个条目。
   */
  async function reloadDir(dir: string): Promise<void> {
    if (mode.value !== "disk") return; // vfs 由路径清单派生，写入即刷新
    try {
      const entries = await listDir(dir);
      const previous = new Map(childrenOf(dir).map((node) => [normalizePath(node.path), node]));
      const merged = sortEntries(
        entries.map((entry) => {
          const path = entry.origin ?? joinPath(dir, entry.name);
          const old = previous.get(normalizePath(path));
          return old && old.kind === entry.kind ? old : { name: entry.name, path, kind: entry.kind };
        }),
      );
      if (normalizePath(dir) === normalizePath(root.value)) {
        diskNodes.value = merged;
        return;
      }
      const node = findNode(dir);
      if (!node) return;
      node.children = merged;
      // 触发响应式：node 是深层对象，直接改 children 不一定被 computed 感知。
      diskNodes.value = [...diskNodes.value];
    } catch (cause: unknown) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** 丢弃某路径及其下级的展开 / 加载态（条目已被改名或移动走，这些标记会变成悬空项）。 */
  function forgetPath(path: string): void {
    const base = normalizePath(path);
    const stale = (item: string): boolean => {
      const current = normalizePath(item);
      return current === base || current.startsWith(`${base}/`);
    };
    expanded.value = new Set([...expanded.value].filter((item) => !stale(item)));
    loadingPaths.value = new Set([...loadingPaths.value].filter((item) => !stale(item)));
  }

  /**
   * 父目录。用 `normalizePath` 的形态找切点（分隔符已统一），再按**原串**截断 ——
   * 这样回给宿主的路径仍保留它给的那套分隔符（Windows 上是反斜杠）。
   */
  function parentOf(path: string): string {
    const normalized = normalizePath(path);
    const cut = normalized.lastIndexOf("/");
    if (cut < 0) return "";
    return cut === 0 ? normalized.slice(0, 1) : path.slice(0, cut);
  }

  /** 新建文件 / 文件夹；成功后展开父目录，让新条目立刻可见。 */
  async function createEntry(parent: string, name: string, kind: FileTreeNode["kind"]): Promise<void> {
    assertDiskMode();
    const path = joinPath(parent, name);
    if (kind === "file") await createFile(path);
    else await createDir(path);
    expanded.value = new Set(expanded.value).add(parent);
    await reloadDir(parent);
  }

  /** 改名 / 移动；同步已打开的预览 tab（它们持有旧路径，下次保存会写错地方）。 */
  async function moveEntry(from: string, to: string): Promise<void> {
    assertDiskMode();
    await renamePath(from, to);
    forgetPath(from);
    const targetParent = parentOf(to);
    await reloadDir(targetParent);
    const sourceParent = parentOf(from);
    if (normalizePath(sourceParent) !== normalizePath(targetParent)) await reloadDir(sourceParent);
    usePreviewStore().retargetPath(from, to);
  }

  /** 就地改名：目标路径由「父目录 + 新名」拼出，调用方不必自己切路径。 */
  async function renameEntry(path: string, newName: string): Promise<void> {
    await moveEntry(path, joinPath(parentOf(path), newName));
  }

  /** 把剪贴板里的条目粘贴进目录；剪切是移动，复制是复制。 */
  async function pasteInto(dir: string): Promise<void> {
    const entry = clipboard.value;
    if (!entry) return;
    assertDiskMode();
    const target = joinPath(dir, entry.name);
    if (entry.mode === "copy") {
      await copyPath(entry.path, target);
      await reloadDir(dir);
      return;
    }
    await moveEntry(entry.path, target);
    clipboard.value = null; // 剪切只生效一次（失败时抛在上面，剪贴板保留，用户可重试）
  }

  /** 删除条目；受影响的预览 tab 一并关掉。调用方负责先兜住未保存的编辑。 */
  async function deleteEntry(path: string): Promise<void> {
    assertDiskMode();
    await deletePath(path);
    forgetPath(path);
    await reloadDir(parentOf(path));
    usePreviewStore().closeUnder(path);
  }

  function cutToClipboard(entry: Omit<ClipboardEntry, "mode">): void {
    clipboard.value = { ...entry, mode: "cut" };
  }

  function copyToClipboard(entry: Omit<ClipboardEntry, "mode">): void {
    clipboard.value = { ...entry, mode: "copy" };
  }

  function clearClipboard(): void {
    clipboard.value = null;
  }

  /**
   * 绑定的文件夹变化（切换工作区 / 换绑 / 切对话）就重载树。
   *
   * 计算属性只读 store 状态，所以切工作区天然触发；副作用放 store 的 effect scope 里，
   * 随 pinia 实例销毁，不像模块级事件总线那样跨测试泄漏。
   */
  const boundFolder = computed(() => activeConversationFolder() ?? activeWorkspaceFolder());
  watch(boundFolder, () => {
    void refresh();
  });

  return {
    mode,
    root,
    bound,
    nodes,
    error,
    loadingRoot,
    boundFolder,
    clipboard,
    refresh,
    bindFolder,
    toggle,
    isExpanded,
    isLoading,
    parentOf,
    reloadDir,
    createEntry,
    renameEntry,
    moveEntry,
    pasteInto,
    deleteEntry,
    cutToClipboard,
    copyToClipboard,
    clearClipboard,
  };
});
