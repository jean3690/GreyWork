import { createTauriGitService, type GitChange, type GitService } from "@greywork/editor";
import { isTauriRuntime } from "@greywork/core";
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { resolveWorkspaceRoot } from "../lib/workspace-dir";
import { activeConversationFolder } from "../lib/conversation-folder";
import { activeWorkspaceFolder } from "../lib/artifact-dir";

/**
 * Git 变更面板状态（预览侧栏「变更」区段的数据源）。
 *
 * 与 fileTree 的 disk 模式同源：工作区根由 `resolveWorkspaceRoot` 解析（对话绑定 →
 * 工作区绑定 → 设置项/宿主私有根），服务经 `@greywork/editor` 的 Tauri 适配器走宿主
 * `git` CLI —— 每次查询实时读磁盘，ACP agent 落盘的文件立刻可见。
 *
 * 纠错语义：
 * - 浏览器态（无 Tauri）整段回落空态，不弹错 —— 网页里本来就没有磁盘；
 * - 目录不是 git 仓库 → Rust 侧 stderr 原文直接展示，面板给出错误态；
 * - untracked 文件没有行级统计（numstat 只覆盖已跟踪内容），UI 用「新增」徽标兜语义。
 */
export const useGitStore = defineStore("git", () => {
  const root = ref<string | null>(null);
  const branch = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const entries = ref<GitChange[]>([]);
  const selected = ref<string | null>(null);
  const diffCache = ref<Record<string, string>>({});
  const diffLoading = ref(false);
  const diffError = ref<string | null>(null);

  /**
   * diff 缓存上限：一条是整份 unified diff 文本，大仓库里单个文件就上百 KB。
   * 不设上限时"点过多少文件就留多少"，低内存设备上会随浏览单调推高常驻内存。
   *
   * 淘汰按插入序（Record 的字符串键保持插入序）而非最近使用 —— 读取路径是组件里
   * 直接属性访问（`git.diffCache[path]`），做命中刷新就得把读也收进 store，收益不值这个改动。
   * 代价只是回看很久以前的文件会重新取一次 diff。
   */
  const DIFF_CACHE_LIMIT = 32;

  /** 写入 diff 并收敛缓存大小。每次写入都整表复制，有界才不会被"复制 + 增长"拖成平方级。 */
  function putDiff(path: string, text: string): void {
    const next: Record<string, string> = { ...diffCache.value, [path]: text };
    const keys = Object.keys(next);
    if (keys.length > DIFF_CACHE_LIMIT) {
      for (const stale of keys.slice(0, keys.length - DIFF_CACHE_LIMIT)) delete next[stale];
    }
    diffCache.value = next;
  }

  const commitMessage = ref("");
  const committing = ref(false);
  const commitError = ref<string | null>(null);
  const lastCommitId = ref<string | null>(null);

  /** 当前工作区根的 Git 服务。**不初始化就调用**：refresh 里先解析根再建。 */
  let service: GitService | null = null;

  const activeEntries = () => entries.value;
  const totalAdds = () => entries.value.reduce((sum, entry) => sum + entry.add, 0);
  const totalDels = () => entries.value.reduce((sum, entry) => sum + entry.del, 0);
  const dirtyCount = () => entries.value.length;

  function clearError(): void {
    error.value = null;
  }

  function resetHostState(): void {
    root.value = null;
    branch.value = null;
    entries.value = [];
    selected.value = null;
    diffCache.value = {};
    diffError.value = null;
    service = null;
    error.value = null;
  }

  async function refresh(): Promise<void> {
    if (!isTauriRuntime()) {
      resetHostState();
      return;
    }
    loading.value = true;
    diffError.value = null;
    commitError.value = null;
    try {
      const resolution = await resolveWorkspaceRoot();
      root.value = resolution.dir;
      service = createTauriGitService(resolution.dir);
      const [changesResult, branchResult] = await Promise.allSettled([service.changes(), service.currentBranch()]);
      if (changesResult.status === "fulfilled") {
        entries.value = changesResult.value;
        error.value = null;
      } else {
        // 非 git 仓库 / 读失败：清空条目并给原文错误。
        entries.value = [];
        error.value = changesResult.reason instanceof Error ? changesResult.reason.message : String(changesResult.reason);
      }
      branch.value = branchResult.status === "fulfilled" ? branchResult.value : null;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      entries.value = [];
    } finally {
      loading.value = false;
    }
  }

  /** 选中某条变更并取回它的统一 diff（缓存按路径留一次）。 */
  async function select(path: string): Promise<void> {
    if (selected.value === path && diffCache.value[path] !== undefined) return;
    selected.value = path;
    if (diffCache.value[path] !== undefined) return;
    if (!service) return;
    diffLoading.value = true;
    diffError.value = null;
    try {
      putDiff(path, await service.diff(path));
    } catch (cause) {
      diffError.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      diffLoading.value = false;
    }
  }

  function deselect(): void {
    selected.value = null;
  }

  /** 提交全部工作区变更；成功后清空提交框并刷新状态。 */
  async function commitAll(): Promise<void> {
    if (!service) return;
    const message = commitMessage.value.trim();
    if (!message) return;
    committing.value = true;
    commitError.value = null;
    try {
      const result = await service.commit(message);
      lastCommitId.value = result.hash;
      commitMessage.value = "";
      await refresh();
    } catch (cause) {
      commitError.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      committing.value = false;
    }
  }

  // 绑定的工作区文件夹变化（切换工作区 / 换绑 / 切对话）就重载 git 状态。
  const boundFolder = () => activeConversationFolder() ?? activeWorkspaceFolder();
  watch(boundFolder, () => {
    if (isTauriRuntime()) void refresh();
  });

  return {
    root,
    branch,
    loading,
    error,
    entries,
    selected,
    diffCache,
    diffLoading,
    diffError,
    commitMessage,
    committing,
    commitError,
    lastCommitId,
    activeEntries,
    totalAdds,
    totalDels,
    dirtyCount,
    refresh,
    select,
    deselect,
    commitAll,
    clearError,
  };
});
