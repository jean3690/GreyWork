import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { basename, isTauriRuntime, joinPath, normalizePath } from "@greywork/core";
import { listDir } from "../state/workspaceFiles";
import { resolveWorkspaceRoot } from "../lib/workspace-dir";
import { activeWorkspaceFolder } from "../lib/artifact-dir";
import { activeConversationFolder } from "../lib/conversation-folder";
import { pickWorkspaceFolder } from "../lib/workspace-picker";
import { bindWorkspaceFolder } from "../lib/workspace-bind";
import { buildFileTree, useVfsStore } from "./vfs";
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
    refresh,
    bindFolder,
    toggle,
    isExpanded,
    isLoading,
  };
});
