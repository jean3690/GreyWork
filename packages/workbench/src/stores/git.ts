import { createTauriGitService, type GitChange, type GitCommit, type HistoryGitService } from "@greywork/editor";
import { isTauriRuntime } from "@greywork/core";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
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
  /** 选中项的缓存键（`index:path` / `work:path`）；null = 没展开。 */
  const selected = ref<string | null>(null);
  const diffCache = ref<Record<string, string>>({});
  const diffLoading = ref(false);
  const diffError = ref<string | null>(null);
  /** 暂存 / 取消暂存的在途态与失败文案（与提交分开，面板上的位置也不同）。 */
  const staging = ref(false);
  const stagingError = ref<string | null>(null);

  /**
   * 同一路径可能在两侧各有一条（porcelain 的 `MM`），所以缓存键必须带侧别 ——
   * 只用路径会让「已暂存那一版」的 diff 覆盖掉「未暂存那一版」。
   */
  function keyOf(path: string, staged: boolean): string {
    return `${staged ? "index" : "work"}:${path}`;
  }

  /** 已暂存 / 未暂存两个分区；同一文件两侧都有改动时两个分区各出现一次（各家 git UI 的通行做法）。 */
  const stagedEntries = computed(() => entries.value.filter((entry) => entry.index !== null));
  const unstagedEntries = computed(() => entries.value.filter((entry) => entry.worktree !== null));

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

  /* ===== 提交历史（面板「历史」页） =====
   * 惰性加载：切到「历史」页才拉第一页，免得每次开面板都多打一次 IPC。
   */

  /** 单页条数（与宿主的默认上限对齐）。 */
  const HISTORY_PAGE = 50;

  const history = ref<GitCommit[]>([]);
  const historyLoading = ref(false);
  const historyError = ref<string | null>(null);
  /** 已经拉过至少一页。用于「切到历史页要不要自动加载」的判断，区别于「列表为空」。 */
  const historyLoaded = ref(false);
  /** 还有更早的提交可拉（上一页取满了一整页）。 */
  const historyHasMore = ref(false);
  /** 展开的提交 hash；null = 没展开。 */
  const historySelected = ref<string | null>(null);
  const historyDiffCache = ref<Record<string, string>>({});
  const historyDiffLoading = ref(false);
  const historyDiffError = ref<string | null>(null);

  /** 当前工作区根的 Git 服务。**不初始化就调用**：refresh 里先解析根再建。 */
  let service: HistoryGitService | null = null;

  const activeEntries = () => entries.value;
  /** 两侧都算：头部那行给的是「这份工作区一共改了多少行」。 */
  const totalAdds = () => entries.value.reduce((sum, entry) => sum + entry.add + entry.stagedAdd, 0);
  const totalDels = () => entries.value.reduce((sum, entry) => sum + entry.del + entry.stagedDel, 0);
  const dirtyCount = () => entries.value.length;

  /** 某条变更在指定侧的状态（面板按侧渲染徽标）。 */
  function statusOf(entry: GitChange, side: "index" | "work"): string | null {
    return side === "index" ? entry.index : entry.worktree;
  }

  /** 某条变更是否正展开着（键带侧别，两侧同路径各自独立）。 */
  function isSelected(path: string, staged: boolean): boolean {
    return selected.value === keyOf(path, staged);
  }

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
    stagingError.value = null;
    service = null;
    error.value = null;
    resetHistory();
  }

  /** 清空历史页的全部状态（换工作区 / 回落到浏览器态时用）。 */
  function resetHistory(): void {
    history.value = [];
    historyError.value = null;
    historyLoaded.value = false;
    historyHasMore.value = false;
    historySelected.value = null;
    historyDiffCache.value = {};
    historyDiffError.value = null;
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
      // 历史页已经打开过就顺手刷新（提交/暂存后调用 refresh 时，历史也得跟着变）。
      if (historyLoaded.value) await loadHistory(true);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      entries.value = [];
    } finally {
      loading.value = false;
    }
  }

  /** 选中某条变更并取回它**那一侧**的统一 diff（缓存按 `侧:路径` 留一次）。 */
  async function select(path: string, staged: boolean): Promise<void> {
    const key = keyOf(path, staged);
    if (selected.value === key && diffCache.value[key] !== undefined) return;
    selected.value = key;
    if (diffCache.value[key] !== undefined) return;
    if (!service) return;
    diffLoading.value = true;
    diffError.value = null;
    try {
      putDiff(key, await service.diff(path, staged));
    } catch (cause) {
      diffError.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      diffLoading.value = false;
    }
  }

  function deselect(): void {
    selected.value = null;
  }

  /**
   * 暂存 / 取消暂存的公共编排。
   *
   * 成功后**清空 diff 缓存并收起展开项**：条目换了侧，旧键下的 diff 内容已经不对了
   * （比如「未暂存」那一版的 diff 在暂存后就不该再显示）。
   */
  async function runStaging(action: (target: HistoryGitService) => Promise<void>): Promise<void> {
    if (!service) return;
    staging.value = true;
    stagingError.value = null;
    try {
      await action(service);
      diffCache.value = {};
      selected.value = null;
      await refresh();
    } catch (cause) {
      stagingError.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      staging.value = false;
    }
  }

  const stage = (path: string) => runStaging((target) => target.stage([path]));
  const unstage = (path: string) => runStaging((target) => target.unstage([path]));
  const stageAll = () => runStaging((target) => target.stageAll());
  const unstageAll = () => runStaging((target) => target.unstageAll());

  /** 提交：`all = false` 只提交已暂存，`true` 先 `add -A`（旧的「提交全部」）。 */
  async function commitWith(all: boolean): Promise<void> {
    if (!service) return;
    const message = commitMessage.value.trim();
    if (!message) return;
    committing.value = true;
    commitError.value = null;
    try {
      const result = await service.commit(message, { all });
      lastCommitId.value = result.hash;
      commitMessage.value = "";
      diffCache.value = {};
      selected.value = null;
      await refresh();
    } catch (cause) {
      commitError.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      committing.value = false;
    }
  }

  const commitStaged = () => commitWith(false);
  const commitAll = () => commitWith(true);

  /* ===== 历史页动作 ===== */

  /**
   * 拉取提交历史。`reset = true` 从最新一页重来（切页/提交后），否则接着往下翻。
   *
   * 翻页用「已加载条数」当 `skip`，不在前端合并去重 —— 宿主按 `--skip/--max-count`
   * 顺序返回，同一分支上不会重叠；`reset` 时的整体替换也顺手丢掉了已消失的提交（如 amend）。
   */
  async function loadHistory(reset = false): Promise<void> {
    if (!service || historyLoading.value) return;
    historyLoading.value = true;
    historyError.value = null;
    try {
      const skip = reset ? 0 : history.value.length;
      const page = await service.log({ limit: HISTORY_PAGE, skip });
      history.value = reset ? page : [...history.value, ...page];
      // 取满一整页就假定还有更早的（不额外查 count：`rev-list --count` 在大仓库里很贵）。
      historyHasMore.value = page.length === HISTORY_PAGE;
      historyLoaded.value = true;
    } catch (cause) {
      historyError.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      historyLoading.value = false;
    }
  }

  /** 展开某次提交的 diff（缓存一次，重开同一提交不再打 IPC）。 */
  async function selectCommit(hash: string): Promise<void> {
    if (historyDiffCache.value[hash] !== undefined) {
      historySelected.value = hash;
      return;
    }
    if (!service) return;
    historySelected.value = hash;
    historyDiffLoading.value = true;
    historyDiffError.value = null;
    try {
      const text = await service.show(hash);
      historyDiffCache.value = { ...historyDiffCache.value, [hash]: text };
    } catch (cause) {
      historyDiffError.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      historyDiffLoading.value = false;
    }
  }

  function deselectCommit(): void {
    historySelected.value = null;
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
    staging,
    stagingError,
    stagedEntries,
    unstagedEntries,
    commitMessage,
    committing,
    commitError,
    lastCommitId,
    history,
    historyLoading,
    historyError,
    historyLoaded,
    historyHasMore,
    historySelected,
    historyDiffCache,
    historyDiffLoading,
    historyDiffError,
    activeEntries,
    totalAdds,
    totalDels,
    dirtyCount,
    statusOf,
    isSelected,
    refresh,
    select,
    deselect,
    stage,
    unstage,
    stageAll,
    unstageAll,
    commitStaged,
    commitAll,
    loadHistory,
    selectCommit,
    deselectCommit,
    clearError,
  };
});
