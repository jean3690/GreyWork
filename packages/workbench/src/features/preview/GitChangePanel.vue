<script setup lang="ts">
/**
 * 预览侧栏「变更」区段：当前工作区的 git 变更列表 + 行级 diff + 一键提交。
 *
 * 数据来自 `stores/git.ts`（真实磁盘 + 宿主 git CLI）；每次切入本区段都会重新 mount
 * 整面板（PreviewSider 用 v-if 切换区段），所以列表天然与磁盘同步 —— ACP agent 刚落盘
 * 的改动切过来就能看见。
 *
 * diff 复用 `lib/unified-diff`（与 DiffViewer 同一解析器）：行级着色 + 双列行号，
 * 不另写一套 patch 渲染。二进制或纯删除场景没有 numstat 行数，靠徽标兜语义。
 */
import { computed, onMounted } from "vue";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import { parseUnifiedDiff } from "@/lib/unified-diff";
import { useGitStore } from "@/stores/git";

const git = useGitStore();

onMounted(() => {
  // 区段切换会卸载/重挂面板（PreviewSider 的 v-if），每次切进来都对磁盘刷新一次。
  void git.refresh();
});

/** 状态 → 徽标（字母 + 配色 + 文案）；`staged` 用实心底强调「已入暂存区」。 */
const BADGE: Record<string, { letter: string; cls: string; label: string }> = {
  modified: { letter: "M", cls: "text-amber", label: "修改" },
  added: { letter: "A", cls: "text-mint", label: "新增" },
  deleted: { letter: "D", cls: "text-orange", label: "删除" },
  renamed: { letter: "R", cls: "text-cyan", label: "重命名" },
  untracked: { letter: "U", cls: "text-sky", label: "未跟踪" },
};

function badgeFor(status: string): { letter: string; cls: string; label: string } {
  return BADGE[status] ?? { letter: "?", cls: "text-dim2", label: status };
}

/** 选中项的行级 diff 文件段。空文案（成功但无内容）→ 二进制/纯重命名。 */
const selectedDiff = computed(() => {
  const text = git.selected === null ? "" : (git.diffCache[git.selected] ?? "");
  return parseUnifiedDiff(text);
});

const selectedEmpty = computed(() => git.selected !== null && git.diffCache[git.selected] !== undefined && selectedDiff.value.length === 0);

const LINE_LIMIT = 5000;
const LINE_CLASS: Record<string, string> = {
  header: "bg-panel text-dim2",
  hunk: "bg-panel text-dim2",
  meta: "text-dim2",
  add: "bg-mint/10 text-mint",
  del: "bg-orange/10 text-orange",
  context: "text-dim",
};
const MARKER: Record<string, string> = { add: "+", del: "-", context: " ", meta: "", header: "", hunk: "" };

function toggle(path: string): void {
  if (git.selected === path) git.deselect();
  else void git.select(path);
}
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- 头部：分支 + 汇总计数 + 刷新 -->
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
      <span class="min-w-0 truncate text-[11.5px] text-dim">
        <span class="font-mono text-foreground">{{ git.branch || "–" }}</span>
        <span v-if="git.dirtyCount() > 0" class="ms-1.5 text-dim2">
          {{ git.dirtyCount() }} 个文件<span v-if="git.totalAdds() + git.totalDels() > 0" class="ms-1">·</span>
          <span v-if="git.totalAdds()" class="text-mint">+{{ git.totalAdds() }}</span>
          <span v-if="git.totalDels()" class="text-orange">-{{ git.totalDels() }}</span>
        </span>
      </span>
      <button
        type="button"
        data-testid="git-refresh"
        class="ms-auto grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        aria-label="刷新变更"
        @click="git.refresh()"
      >
        <Icon name="refresh" :size="13" />
      </button>
    </div>

    <!-- 加载 / 错误 / 空态 -->
    <p v-if="git.loading" class="px-3 py-2 text-[11.5px] text-dim2">正在读取变更…</p>
    <div v-else-if="git.error" role="alert" class="flex flex-col gap-2 px-3 py-3">
      <p class="break-all text-[11.5px] leading-relaxed text-dim">
        当前目录不是 git 仓库或读取失败：<span class="text-orange">{{ git.error }}</span>
      </p>
      <button
        type="button"
        data-testid="git-retry"
        class="self-start cursor-pointer rounded-[6px] px-2 py-1 text-[11px] text-cyan transition-colors hover:bg-panel"
        @click="git.refresh()"
      >
        重试
      </button>
    </div>
    <p v-else-if="git.entries.length === 0" class="px-3 py-3 text-[11.5px] text-dim2">工作区没有未提交的变更</p>

    <!-- 变更列表 + 选中项的 diff -->
    <template v-else>
      <div class="min-h-0 flex-1 overflow-y-auto" data-scroll-root>
        <ul class="flex flex-col py-1">
          <li v-for="entry in git.entries" :key="entry.path">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-panel"
              data-testid="git-entry"
              :aria-expanded="git.selected === entry.path ? 'true' : 'false'"
              @click="toggle(entry.path)"
            >
              <Hint :text="badgeFor(entry.status).label">
                <span
                  class="grid size-4 shrink-0 place-items-center rounded-[4px] bg-panel text-[10px] font-semibold"
                  :class="badgeFor(entry.status).cls"
                >
                  {{ badgeFor(entry.status).letter }}
                </span>
              </Hint>
              <!-- 已暂存指示：小实心点，不参与徽标配色（状态色归字母）。
                   aria-label 已是「已暂存」，重复的 title 不再留。 -->
              <span v-if="entry.staged" class="size-1.5 shrink-0 rounded-full bg-cyan" aria-label="已暂存" />
              <span class="min-w-0 flex-1 truncate text-[11.5px] text-foreground">{{ entry.path }}</span>
              <span v-if="entry.add > 0" class="shrink-0 text-[10.5px] tabular-nums text-mint">+{{ entry.add }}</span>
              <span v-if="entry.del > 0" class="shrink-0 text-[10.5px] tabular-nums text-orange">-{{ entry.del }}</span>
            </button>

            <div v-if="git.selected === entry.path" class="border-l-2 border-cyan bg-panel-2" data-testid="git-entry-diff">
              <p v-if="git.diffLoading" class="px-3 py-2 text-[11px] text-dim2">读取 diff…</p>
              <p v-else-if="git.diffError" class="break-all px-3 py-2 text-[11px] text-orange">{{ git.diffError }}</p>
              <p v-else-if="selectedEmpty" class="px-3 py-2 text-[11px] text-dim2">二进制或没有文本变化</p>
              <template v-else>
                <section v-for="file in selectedDiff" :key="file.path" class="py-1">
                  <header class="flex items-center gap-2 border-y border-line px-3 py-1 text-[10.5px]">
                    <span class="min-w-0 flex-1 truncate text-dim">{{ file.path }}</span>
                    <span class="shrink-0 text-mint">+{{ file.added }}</span>
                    <span class="shrink-0 text-orange">-{{ file.removed }}</span>
                  </header>
                  <div class="px-2 font-mono text-[11px] leading-[1.5]">
                    <div
                      v-for="(line, index) in file.lines.slice(0, LINE_LIMIT)"
                      :key="index"
                      class="flex items-start"
                      :class="LINE_CLASS[line.kind]"
                    >
                      <span class="w-9 shrink-0 select-none px-1 text-right tabular-nums text-dim2">{{ line.oldNo ?? "" }}</span>
                      <span class="w-9 shrink-0 select-none px-1 text-right tabular-nums text-dim2">{{ line.newNo ?? "" }}</span>
                      <span class="w-3 shrink-0 select-none text-center">{{ MARKER[line.kind] }}</span>
                      <span class="min-w-0 flex-1 whitespace-pre-wrap break-all pe-2">{{ line.text }}</span>
                    </div>
                  </div>
                  <p v-if="file.lines.length > LINE_LIMIT" class="px-3 py-1 text-[10.5px] text-dim2">仅显示前 {{ LINE_LIMIT }} 行</p>
                </section>
              </template>
            </div>
          </li>
        </ul>
      </div>

      <!-- 提交条：默认收着，点提交输入展开 diff 区域不需要 —— 独立在面板底部 -->
      <form
        class="flex shrink-0 flex-col gap-1.5 border-t border-line px-3 py-2"
        data-testid="git-commit-box"
        @submit.prevent="git.commitAll()"
      >
        <label class="text-[10.5px] font-medium uppercase tracking-wide text-dim2" for="git-commit-input">提交全部变更</label>
        <div class="flex items-center gap-1.5">
          <input
            id="git-commit-input"
            v-model="git.commitMessage"
            type="text"
            class="min-w-0 flex-1 rounded-[6px] border border-line bg-panel px-2 py-1 text-[11.5px] text-foreground placeholder:text-dim2 focus:border-cyan focus:outline-none"
            placeholder="提交信息…"
            maxlength="200"
          />
          <button
            type="submit"
            data-testid="git-commit-submit"
            class="grid size-7 shrink-0 cursor-pointer place-items-center rounded-[6px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
            :class="git.commitMessage.trim() ? 'bg-cyan text-white hover:bg-cyan/90' : 'bg-panel text-dim2'"
            :disabled="!git.commitMessage.trim() || git.committing || git.entries.length === 0"
            aria-label="提交"
          >
            <Icon name="check" :size="13" />
          </button>
        </div>
        <p v-if="git.commitError" role="alert" class="break-all text-[11px] text-orange">{{ git.commitError }}</p>
        <p v-else-if="git.lastCommitId" class="text-[10.5px] text-dim2">
          <span class="font-mono text-mint">{{ git.lastCommitId }}</span> 已提交
        </p>
        <p v-if="git.committing" class="text-[11px] text-dim2">提交中…</p>
      </form>
    </template>
  </div>
</template>
