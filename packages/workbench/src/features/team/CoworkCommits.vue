<script setup lang="ts">
/**
 * 协作「提交」卡：展示队友（各成员 agent）在共享工作区里产出的提交。
 *
 * 协作成员跑在同一份隔离工作区、同一条 `greywork/<slug>-<hash>` 分支上，所以
 * 「别人的 commit」就是这份工作区的提交历史。数据来自 cowork store 的 git 快照：
 * 起跑时记基线，之后新增的行标「本轮」。点一行按需拉该提交的 diff。
 *
 * 非 git 工作区（或浏览器态）整段隐藏，不占地方也不报错。
 */
import { useI18n } from "vue-i18n";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import { authorColor, authorInitial } from "@/lib/author-identity";
import { useCoworkStore, type CoworkCommitView } from "@/stores/cowork";
import { ref } from "vue";

const { t } = useI18n();
const cowork = useCoworkStore();

const expanded = ref<string | null>(null);

function toggleDiff(commit: CoworkCommitView): void {
  if (expanded.value === commit.hash) {
    expanded.value = null;
    return;
  }
  expanded.value = commit.hash;
  void cowork.loadCommitDiff(commit.hash);
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <div v-if="cowork.runWorkspace" class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-3.5">
    <div class="mb-2 flex items-center gap-2">
      <Icon name="history" :size="13" class="text-dim" />
      <span class="text-[11px] font-medium text-dim">{{ t("cowork.commits.title") }}</span>
      <span
        v-if="cowork.runBranch"
        class="max-w-[180px] truncate rounded-full bg-panel-2 px-2 py-0.5 font-mono text-[10px] text-cyan"
        :title="cowork.runBranch"
      >
        {{ cowork.runBranch }}
      </span>
      <span v-if="cowork.commitViews.length > 0" class="rounded-full bg-panel-2 px-1.5 text-[10px] text-dim2">{{
        cowork.commitViews.length
      }}</span>
      <Hint :text="t('cowork.commits.refresh')">
        <button
          type="button"
          data-testid="cowork-commits-refresh"
          class="ml-auto grid size-6 place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground disabled:opacity-50"
          :disabled="cowork.commitsLoading"
          :aria-label="t('cowork.commits.refresh')"
          @click="cowork.refreshCommits()"
        >
          <Icon name="refresh" :size="12" />
        </button>
      </Hint>
    </div>

    <p v-if="!cowork.commitsAvailable" class="text-[11px] text-dim2">{{ t("cowork.commits.noRepo") }}</p>
    <p v-else-if="cowork.commitViews.length === 0" class="text-[11px] text-dim2">
      {{ cowork.commitsLoading ? t("cowork.commits.diffLoading") : t("cowork.commits.empty") }}
    </p>
    <div v-else data-testid="cowork-commits" class="flex flex-col gap-1">
      <div v-for="commit in cowork.commitViews" :key="commit.hash">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-[calc(10px*var(--gw-radius-scale))] bg-panel-2 px-2.5 py-1.5 text-left transition-colors hover:bg-panel"
          :data-testid="`cowork-commit-${commit.shortHash}`"
          @click="toggleDiff(commit)"
        >
          <span
            class="grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-medium text-accent-ink"
            :style="{ background: authorColor(commit.email || commit.author) }"
          >
            {{ authorInitial(commit.author) }}
          </span>
          <span class="min-w-0 flex-1 truncate text-[12px] text-foreground">{{ commit.subject }}</span>
          <span v-if="commit.fromRun" class="shrink-0 rounded-full bg-cyan/15 px-1.5 text-[10px] text-cyan">{{
            t("cowork.commits.fromRun")
          }}</span>
          <span class="shrink-0 font-mono text-[10px] text-dim2">{{ commit.shortHash }}</span>
          <span class="shrink-0 text-[10px] text-dim2">{{ commit.author }}</span>
          <span class="shrink-0 tabular-nums text-[10px] text-dim2">{{ timeOf(commit.timestamp) }}</span>
        </button>
        <div v-if="expanded === commit.hash" class="mt-1 rounded-[calc(10px*var(--gw-radius-scale))] bg-panel-2 px-2.5 py-2">
          <p v-if="cowork.commitDiffLoading && cowork.commitDiffCache[commit.hash] === undefined" class="text-[11px] text-dim2">
            {{ t("cowork.commits.diffLoading") }}
          </p>
          <p v-else-if="cowork.commitDiffError" class="text-[11px] text-destructive">{{ cowork.commitDiffError }}</p>
          <pre v-else class="max-h-[320px] overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-dim">{{
            cowork.commitDiffCache[commit.hash]
          }}</pre>
        </div>
      </div>
    </div>
    <p v-if="cowork.commitsError && cowork.commitsAvailable" class="mt-1.5 text-[11px] text-destructive">
      {{ t("cowork.commits.error") }}
    </p>
  </div>
</template>
