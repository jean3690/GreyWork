<script setup lang="ts">
/**
 * 预览侧栏「变更」区段：当前工作区的 git 变更分「已暂存 / 未暂存」两区展示，
 * 支持逐文件暂存与取消暂存、只提交已暂存（另留一个「全部提交」）、以及行级 diff。
 *
 * 面板顶部另有「历史」页：提交列表 + 单次提交的 diff（只读）。两页共用同一个虚拟器
 * 是不可能的（行形状不同），历史页按普通列表渲染 —— 一页 50 条、最多翻到 200 条，
 * 不值得再养一个虚拟器。历史惰性加载：第一次切到「历史」才拉第一页。
 *
 * 数据来自 `stores/git.ts`（真实磁盘 + 宿主 git CLI）；每次切入本区段都会重新 mount
 * 整面板（PreviewSider 用 v-if 切换区段），所以列表天然与磁盘同步 —— ACP agent 刚落盘
 * 的改动切过来就能看见。
 *
 * **一个文件可能同时出现在两个分区**（porcelain 的 `MM`）：改了、暂存、再改。这不是重复 ——
 * 两侧的 diff 内容不同，提交也只吃已暂存那一侧。所以行键与 diff 缓存键都必须带侧别，
 * 否则两条会互相覆盖。
 *
 * diff 复用 `lib/unified-diff`（与 DiffViewer 同一解析器）：行级着色 + 双列行号，
 * 不另写一套 patch 渲染。二进制或纯重命名场景没有 numstat 行数，靠徽标兜语义。
 */
import { computed, onMounted, ref } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import GitDiffBody from "@/features/preview/GitDiffBody.vue";
import { deviceTier } from "@/lib/device-tier";
import { observeNonZeroRect } from "@/lib/virtual-rect";
import { parseUnifiedDiff } from "@/lib/unified-diff";
import { useGitStore } from "@/stores/git";
import { i18n } from "@/i18n";
import type { GitChange } from "@greywork/editor";

const git = useGitStore();

/** 面板可能被直接 mount（测试），不依赖宿主的 i18n 插件，故用全局实例。 */
const t = i18n.global.t;

type Side = "index" | "work";
/** 面板的两个页：变更（可暂存/提交）/ 历史（只读）。 */
type Mode = "changes" | "history";

const mode = ref<Mode>("changes");

onMounted(() => {
  // 区段切换会卸载/重挂面板（PreviewSider 的 v-if），每次切进来都对磁盘刷新一次。
  void git.refresh();
});

/** 惰性加载历史：第一次切到「历史」才拉第一页；之后切回来不重复拉（提交时会自动刷新）。 */
function setMode(next: Mode): void {
  if (mode.value === next) return;
  mode.value = next;
  if (next === "history" && !git.historyLoaded) void git.loadHistory();
}

/** 展开 / 收起某次提交的 diff。 */
function toggleCommit(hash: string): void {
  if (git.historySelected === hash) git.deselectCommit();
  else void git.selectCommit(hash);
}

/** ISO 8601 → `YYYY-MM-DD HH:mm`。取字符串切片而不是 `toLocaleString`：不引 locale 差异，测试也好钉。 */
function formatWhen(timestamp: string): string {
  return timestamp.replace("T", " ").slice(0, 16);
}

/** 差异文本「没有可渲染内容」（二进制 / 纯重命名）—— 空态文案靠它，别把空 diff 画成空白块。 */
function isEmptyDiff(text: string | undefined): boolean {
  return text !== undefined && parseUnifiedDiff(text).length === 0;
}

const modeClass = (active: boolean): string =>
  [
    "cursor-pointer rounded-[5px] px-1.5 py-0.5 text-[10.5px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    active ? "bg-panel-2 text-foreground" : "text-dim2 hover:text-foreground",
  ].join(" ");

/** 状态 → 徽标（字母 + 配色 + 文案键）；文案在读取时翻译，切语言才能跟着变。 */
const BADGE: Record<string, { letter: string; cls: string; key: string }> = {
  modified: { letter: "M", cls: "text-amber", key: "preview.git.status.modified" },
  added: { letter: "A", cls: "text-mint", key: "preview.git.status.added" },
  deleted: { letter: "D", cls: "text-orange", key: "preview.git.status.deleted" },
  renamed: { letter: "R", cls: "text-cyan", key: "preview.git.status.renamed" },
  untracked: { letter: "U", cls: "text-sky", key: "preview.git.status.untracked" },
};

function badgeFor(status: string | null): { letter: string; cls: string; label: string } {
  const badge = status ? BADGE[status] : undefined;
  if (!badge) return { letter: "?", cls: "text-dim2", label: status ?? "" };
  return { letter: badge.letter, cls: badge.cls, label: t(badge.key) };
}

/** 某条变更在某一侧的行级增删（index 侧与 worktree 侧分别统计，不能相加）。 */
function countsOf(entry: GitChange, side: Side): { add: number; del: number } {
  return side === "index" ? { add: entry.stagedAdd, del: entry.stagedDel } : { add: entry.add, del: entry.del };
}

/* ===== 分区列表 =====
 * 两个分区共用**一个**虚拟器：把「分区标题 + 条目」摊平成一个 rows 数组，行键带侧别
 * （`index:a.txt` / `work:a.txt`）—— 同一路径两侧都出现时键才不冲突。
 */
interface Row {
  kind: "header" | "entry";
  key: string;
  side: Side;
  entry?: GitChange;
  count?: number;
}

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  if (git.stagedEntries.length > 0) {
    out.push({ kind: "header", key: "header:index", side: "index", count: git.stagedEntries.length });
    for (const entry of git.stagedEntries) out.push({ kind: "entry", key: `index:${entry.path}`, side: "index", entry });
  }
  if (git.unstagedEntries.length > 0) {
    out.push({ kind: "header", key: "header:work", side: "work", count: git.unstagedEntries.length });
    for (const entry of git.unstagedEntries) out.push({ kind: "entry", key: `work:${entry.path}`, side: "work", entry });
  }
  return out;
});

/** 选中项的差异「确实取到了但没内容」→ 二进制 / 纯重命名，给空态文案而不是空白块。 */
const selectedEmpty = computed(() => git.selected !== null && isEmptyDiff(git.diffCache[git.selected]));

/** 历史页展开项同理。 */
const historyDiffEmpty = computed(() => git.historySelected !== null && isEmptyDiff(git.historyDiffCache[git.historySelected]));

/** 提交按钮的可用态：主按钮要求「有提交信息 + 有已暂存内容」，「全部提交」只要工作区有变更。 */
const canCommitStaged = computed(() => git.commitMessage.trim().length > 0 && git.stagedEntries.length > 0 && !git.committing);
const canCommitAll = computed(() => git.commitMessage.trim().length > 0 && git.entries.length > 0 && !git.committing);

function toggle(path: string, side: Side): void {
  const staged = side === "index";
  if (git.isSelected(path, staged)) git.deselect();
  else void git.select(path, staged);
}

/* ===== 行虚拟化 =====
 * 条目数 = 改动文件数，脏工作区里可达上千。行高**不固定**：选中行内联展开整份 diff，
 * 所以走动态测量 —— 每行挂 measureElement，用实际渲染高度校正（同 ConversationView）。
 *
 * 这里刻意**不给行内叠 content-visibility**：那会把屏外子树压成 contain-intrinsic-size
 * 的估算高度，动态测量拿到的就是偏小的错值，滚动条会跳。两种技术在同一棵子树里互斥。
 */
const scrollEl = ref<HTMLElement | null>(null);
const virtualizer = useVirtualizer(
  computed(() => {
    // 先读一次 ref 再闭包捕获：`getScrollElement` 内部读不算依赖，模板 ref 赋值就不会让
    // 这份 options 失效。而滚动容器在 loading/空态分支之后，首帧根本不存在 —— 不显式建立
    // 依赖的话 virtualizer 会一直拿着 null，永远算不出可视行。
    const element = scrollEl.value;
    return {
      getScrollElement: () => element,
      // 丢弃 0×0 视口读数：容器刚挂上时还没布局，0 会覆盖 initialRect 让整列算空（见 lib/virtual-rect.ts）。
      observeElementRect: observeNonZeroRect,
      count: rows.value.length,
      // 首帧视口：RO 就位前先按它渲染窗口，避免空首屏（测试环境无布局时也靠它出内容）。
      initialRect: { top: 0, left: 0, width: 300, height: 600 },
      /** 收起态行高：一行约 26px，留点余量，测量后会被真实高度覆盖。 */
      estimateSize: () => 28,
      overscan: deviceTier.value === "low" ? 3 : 8,
      getItemKey: (index: number) => rows.value[index]?.key ?? index,
    };
  }),
);

/** 可视行 + 它对应的数据；`row` 直接带上，模板里不必再按下标回查。 */
const slots = computed(() =>
  virtualizer.value.getVirtualItems().map((item) => ({
    index: item.index,
    key: String(item.key),
    start: item.start,
    row: rows.value[item.index],
  })),
);

const totalHeight = computed(() => virtualizer.value.getTotalSize());

function measureRow(element: unknown): void {
  if (!(element instanceof HTMLElement)) return;
  // 高度为 0 时**不要**上报：无布局环境（happy-dom）与「元素刚进 DOM 还没布局」这两种情况
  // 量到的都是 0，而 0 会被写进尺寸缓存 —— 整列被压成 0 高，可视行算出来是空的，行随即
  // 全部卸载。真实浏览器里行总是有高度，所以这条守卫只在量不出高度时生效。
  if (element.getBoundingClientRect().height === 0) return;
  virtualizer.value.measureElement(element);
}

const rowButtonClass =
  "grid size-5 shrink-0 cursor-pointer place-items-center rounded-[5px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40";
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- 头部：页切换 + 分支/汇总计数 + 全部暂存 / 全部取消 + 刷新 -->
    <div class="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5">
      <div class="flex shrink-0 items-center gap-0.5 rounded-[6px] bg-panel p-0.5" role="tablist">
        <button
          type="button"
          role="tab"
          data-testid="git-mode-changes"
          :aria-selected="mode === 'changes' ? 'true' : 'false'"
          :class="modeClass(mode === 'changes')"
          @click="setMode('changes')"
        >
          {{ t("preview.git.tab.changes") }}
        </button>
        <button
          type="button"
          role="tab"
          data-testid="git-mode-history"
          :aria-selected="mode === 'history' ? 'true' : 'false'"
          :class="modeClass(mode === 'history')"
          @click="setMode('history')"
        >
          {{ t("preview.git.tab.history") }}
        </button>
      </div>

      <span v-if="mode === 'changes'" class="min-w-0 flex-1 truncate text-[11.5px] text-dim">
        <span class="font-mono text-foreground">{{ git.branch || "–" }}</span>
        <span v-if="git.dirtyCount() > 0" class="ms-1.5 text-dim2">
          {{ t("preview.git.files", { n: git.dirtyCount() }) }}<span v-if="git.totalAdds() + git.totalDels() > 0" class="ms-1">·</span>
          <span v-if="git.totalAdds()" class="text-mint">+{{ git.totalAdds() }}</span>
          <span v-if="git.totalDels()" class="text-orange">-{{ git.totalDels() }}</span>
        </span>
      </span>
      <span v-else class="min-w-0 flex-1 truncate text-[11.5px] text-dim2">
        <span class="font-mono text-foreground">{{ git.branch || "–" }}</span>
      </span>

      <div class="ms-auto flex shrink-0 items-center gap-1">
        <button
          v-if="mode === 'changes' && git.stagedEntries.length > 0"
          type="button"
          data-testid="git-unstage-all"
          class="shrink-0 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[10.5px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="git.staging"
          @click="git.unstageAll()"
        >
          {{ t("preview.git.unstageAll") }}
        </button>
        <button
          v-if="mode === 'changes' && git.unstagedEntries.length > 0"
          type="button"
          data-testid="git-stage-all"
          class="shrink-0 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[10.5px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="git.staging"
          @click="git.stageAll()"
        >
          {{ t("preview.git.stageAll") }}
        </button>
        <button
          type="button"
          data-testid="git-refresh"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-label="mode === 'history' ? t('preview.git.history.loading') : t('preview.git.refresh')"
          @click="mode === 'history' ? git.loadHistory(true) : git.refresh()"
        >
          <Icon name="refresh" :size="13" />
        </button>
      </div>
    </div>

    <!-- ===== 变更页 ===== -->
    <template v-if="mode === 'changes'">
      <!-- 暂存失败的文案：放在列表上方而不是底部提交框（那是提交的错误位） -->
      <p v-if="git.stagingError" role="alert" class="shrink-0 break-all px-3 py-1.5 text-[11px] text-orange">
        {{ git.stagingError }}
      </p>

      <!-- 加载 / 错误 / 空态 -->
      <p v-if="git.loading" class="px-3 py-2 text-[11.5px] text-dim2">{{ t("preview.git.loading") }}</p>
      <div v-else-if="git.error" role="alert" class="flex flex-col gap-2 px-3 py-3">
        <p class="break-all text-[11.5px] leading-relaxed text-dim">
          {{ t("preview.git.readFailed", { detail: git.error }) }}
        </p>
        <button
          type="button"
          data-testid="git-retry"
          class="self-start cursor-pointer rounded-[6px] px-2 py-1 text-[11px] text-cyan transition-colors hover:bg-panel"
          @click="git.refresh()"
        >
          {{ t("common.retry") }}
        </button>
      </div>
      <p v-else-if="rows.length === 0" class="px-3 py-3 text-[11.5px] text-dim2">{{ t("preview.git.empty") }}</p>

      <!-- 变更列表（已暂存 / 未暂存两区）+ 选中那条的 diff -->
      <template v-else>
        <div ref="scrollEl" class="min-h-0 flex-1 overflow-y-auto py-1" data-scroll-root>
          <!-- 相对容器 + 显式总高：行绝对定位在 translateY 处，高度由 measureElement 校正 -->
          <ul class="relative" :style="{ height: `${totalHeight}px` }">
            <li
              v-for="slot in slots"
              :key="slot.key"
              :ref="measureRow"
              :data-index="slot.index"
              class="absolute left-0 top-0 w-full"
              :style="{ transform: `translateY(${slot.start}px)` }"
            >
              <!-- 分区标题 -->
              <p
                v-if="slot.row.kind === 'header'"
                class="bg-panel px-3 py-1 text-[10.5px] font-medium uppercase tracking-wide text-dim2"
                :data-testid="`git-group-${slot.row.side}`"
              >
                {{ t(slot.row.side === "index" ? "preview.git.stagedGroup" : "preview.git.unstagedGroup", { n: slot.row.count ?? 0 }) }}
              </p>

              <!-- 条目：左侧点开 diff，右侧小按钮做暂存 / 取消暂存 -->
              <template v-else-if="slot.row.entry">
                <div class="flex w-full items-center gap-1 pe-2 transition-colors hover:bg-panel">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1 text-left"
                    data-testid="git-entry"
                    :data-side="slot.row.side"
                    :data-path="slot.row.entry.path"
                    :aria-expanded="git.isSelected(slot.row.entry.path, slot.row.side === 'index') ? 'true' : 'false'"
                    @click="toggle(slot.row.entry.path, slot.row.side)"
                  >
                    <Hint :text="badgeFor(git.statusOf(slot.row.entry, slot.row.side)).label">
                      <span
                        class="grid size-4 shrink-0 place-items-center rounded-[4px] bg-panel text-[10px] font-semibold"
                        :class="badgeFor(git.statusOf(slot.row.entry, slot.row.side)).cls"
                      >
                        {{ badgeFor(git.statusOf(slot.row.entry, slot.row.side)).letter }}
                      </span>
                    </Hint>
                    <span class="min-w-0 flex-1 truncate text-[11.5px] text-foreground">{{ slot.row.entry.path }}</span>
                    <span v-if="countsOf(slot.row.entry, slot.row.side).add > 0" class="shrink-0 text-[10.5px] tabular-nums text-mint">
                      +{{ countsOf(slot.row.entry, slot.row.side).add }}
                    </span>
                    <span v-if="countsOf(slot.row.entry, slot.row.side).del > 0" class="shrink-0 text-[10.5px] tabular-nums text-orange">
                      -{{ countsOf(slot.row.entry, slot.row.side).del }}
                    </span>
                  </button>
                  <button
                    v-if="slot.row.side === 'index'"
                    type="button"
                    data-testid="git-unstage"
                    :class="rowButtonClass"
                    :disabled="git.staging"
                    :aria-label="t('preview.git.unstage')"
                    @click.stop="git.unstage(slot.row.entry.path)"
                  >
                    <Icon name="minus" :size="11" />
                  </button>
                  <button
                    v-else
                    type="button"
                    data-testid="git-stage"
                    :class="rowButtonClass"
                    :disabled="git.staging"
                    :aria-label="t('preview.git.stage')"
                    @click.stop="git.stage(slot.row.entry.path)"
                  >
                    <Icon name="plus" :size="11" />
                  </button>
                </div>

                <div
                  v-if="git.isSelected(slot.row.entry.path, slot.row.side === 'index')"
                  class="border-l-2 border-cyan bg-panel-2"
                  data-testid="git-entry-diff"
                >
                  <p v-if="git.diffLoading" class="px-3 py-2 text-[11px] text-dim2">{{ t("preview.git.diffLoading") }}</p>
                  <p v-else-if="git.diffError" class="break-all px-3 py-2 text-[11px] text-orange">{{ git.diffError }}</p>
                  <p v-else-if="selectedEmpty" class="px-3 py-2 text-[11px] text-dim2">{{ t("preview.git.diffEmpty") }}</p>
                  <GitDiffBody v-else :diff="git.diffCache[git.selected ?? ''] ?? ''" />
                </div>
              </template>
            </li>
          </ul>
        </div>

        <!-- 提交条：主按钮只提交已暂存，另留一个「全部提交」保留旧的 add -A 行为 -->
        <form
          class="flex shrink-0 flex-col gap-1.5 border-t border-line px-3 py-2"
          data-testid="git-commit-box"
          @submit.prevent="git.commitStaged()"
        >
          <label class="text-[10.5px] font-medium uppercase tracking-wide text-dim2" for="git-commit-input">{{
            t("preview.git.commitHint")
          }}</label>
          <div class="flex items-center gap-1.5">
            <input
              id="git-commit-input"
              v-model="git.commitMessage"
              type="text"
              class="min-w-0 flex-1 rounded-[6px] border border-line bg-panel px-2 py-1 text-[11.5px] text-foreground placeholder:text-dim2 focus:border-cyan focus:outline-none"
              :placeholder="t('preview.git.commitPlaceholder')"
              maxlength="200"
            />
            <button
              type="submit"
              data-testid="git-commit-submit"
              class="grid size-7 shrink-0 cursor-pointer place-items-center rounded-[6px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
              :class="canCommitStaged ? 'bg-cyan text-white hover:bg-cyan/90' : 'bg-panel text-dim2'"
              :disabled="!canCommitStaged"
              :aria-label="t('preview.git.commitStaged')"
            >
              <Icon name="check" :size="13" />
            </button>
          </div>
          <button
            type="button"
            data-testid="git-commit-all"
            class="self-start cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[10.5px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!canCommitAll"
            @click="git.commitAll()"
          >
            {{ t("preview.git.commitAll") }}
          </button>
          <p v-if="git.commitError" role="alert" class="break-all text-[11px] text-orange">{{ git.commitError }}</p>
          <p v-else-if="git.lastCommitId" class="text-[10.5px] text-dim2">
            <span class="font-mono text-mint">{{ git.lastCommitId }}</span> {{ t("preview.git.committed") }}
          </p>
          <p v-if="git.committing" class="text-[11px] text-dim2">{{ t("preview.git.committing") }}</p>
        </form>
      </template>
    </template>

    <!-- ===== 历史页（只读：提交列表 + 单次提交的 diff） ===== -->
    <template v-else>
      <p v-if="git.historyLoading && git.history.length === 0" class="px-3 py-2 text-[11.5px] text-dim2">
        {{ t("preview.git.history.loading") }}
      </p>
      <div v-else-if="git.historyError" role="alert" class="flex flex-col gap-2 px-3 py-3">
        <p class="break-all text-[11.5px] leading-relaxed text-dim">
          {{ t("preview.git.history.readFailed", { detail: git.historyError }) }}
        </p>
        <button
          type="button"
          data-testid="git-history-retry"
          class="self-start cursor-pointer rounded-[6px] px-2 py-1 text-[11px] text-cyan transition-colors hover:bg-panel"
          @click="git.loadHistory(true)"
        >
          {{ t("common.retry") }}
        </button>
      </div>
      <p v-else-if="git.history.length === 0" class="px-3 py-3 text-[11.5px] text-dim2">
        {{ t("preview.git.history.empty") }}
      </p>

      <div v-else class="min-h-0 flex-1 overflow-y-auto py-1" data-testid="git-history-list">
        <ul>
          <li v-for="commit in git.history" :key="commit.hash" class="border-b border-line/60 last:border-b-0">
            <button
              type="button"
              data-testid="git-commit-row"
              :data-hash="commit.hash"
              class="flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-panel"
              :aria-expanded="git.historySelected === commit.hash ? 'true' : 'false'"
              @click="toggleCommit(commit.hash)"
            >
              <span class="mt-0.5 shrink-0 font-mono text-[10.5px] text-cyan">{{ commit.shortHash }}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[11.5px] text-foreground">
                  {{ commit.subject || t("preview.git.history.noSubject") }}
                </span>
                <span class="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-dim2">
                  <span class="min-w-0 truncate">{{ commit.author }}</span>
                  <span class="shrink-0">·</span>
                  <span class="shrink-0 tabular-nums">{{ formatWhen(commit.timestamp) }}</span>
                  <span v-if="commit.refs" class="min-w-0 truncate rounded-[4px] bg-panel px-1 text-[10px] text-amber">{{
                    commit.refs
                  }}</span>
                </span>
              </span>
            </button>

            <div v-if="git.historySelected === commit.hash" class="border-l-2 border-cyan bg-panel-2" data-testid="git-commit-diff">
              <p v-if="git.historyDiffLoading" class="px-3 py-2 text-[11px] text-dim2">{{ t("preview.git.diffLoading") }}</p>
              <p v-else-if="git.historyDiffError" class="break-all px-3 py-2 text-[11px] text-orange">{{ git.historyDiffError }}</p>
              <p v-else-if="historyDiffEmpty" class="px-3 py-2 text-[11px] text-dim2">{{ t("preview.git.diffEmpty") }}</p>
              <GitDiffBody v-else :diff="git.historyDiffCache[commit.hash] ?? ''" />
            </div>
          </li>
        </ul>

        <button
          v-if="git.historyHasMore"
          type="button"
          data-testid="git-history-more"
          class="mx-3 my-1.5 cursor-pointer rounded-[6px] px-2 py-1 text-[11px] text-cyan transition-colors hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="git.historyLoading"
          @click="git.loadHistory()"
        >
          {{ t("preview.git.history.loadMore") }}
        </button>
      </div>
    </template>
  </div>
</template>
