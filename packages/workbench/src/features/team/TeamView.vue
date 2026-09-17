<script setup lang="ts">
/**
 * 团队页：
 * 上半是 Cowork 协作运行（leader 拆解派活 + 成员并行执行，靠收件箱与任务板协作），
 * 下半保留 planner 编排运行的看板（自动执行拆解出的并行子任务）。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRunsStore } from "@/stores/runs";
import { useCoworkStore } from "@/stores/cowork";
import Icon from "@/features/shared/Icon.vue";
import CoworkPanel from "@/features/team/CoworkPanel.vue";
import PlannerRunCard from "@/features/team/PlannerRunCard.vue";

const { t } = useI18n();
const runsStore = useRunsStore();
const cowork = useCoworkStore();

const runBadge: Record<string, string> = {
  running: "bg-amber/10 text-amber",
  paused: "bg-cyan/10 text-cyan",
  done: "bg-mint/10 text-mint",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-panel-2 text-dim",
};

const turnsLabel = computed<string>(() => {
  const spend = cowork.spend;
  if (!spend) return "";
  return t("cowork.turns", { used: spend.turns, max: spend.budget.maxTurns });
});
</script>

<template>
  <section class="mx-auto min-h-0 h-full w-full max-w-[860px] overflow-y-auto px-4 py-6 sm:px-6">
    <div class="mb-1 flex items-center gap-2">
      <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">{{ t("cowork.title") }}</h1>
      <span v-if="cowork.status" class="rounded-full px-2 py-0.5 text-[10px] font-medium" :class="runBadge[cowork.status]">
        {{ t(`cowork.runStatus.${cowork.status}`) }}
      </span>
      <span v-if="turnsLabel" class="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[10px] text-dim">
        {{ turnsLabel }}
      </span>
    </div>
    <p class="mb-4 text-[12px] text-dim2">{{ t("cowork.sub") }}</p>

    <CoworkPanel />

    <!-- planner 编排运行（既有） -->
    <div class="mt-6 mb-2 flex items-center gap-2">
      <h2 class="font-display text-[14px] font-semibold text-foreground">编排运行</h2>
      <span class="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[10px] text-dim">
        并行上限 {{ runsStore.maxParallel }}
      </span>
    </div>

    <div v-if="runsStore.runs.length === 0" class="flex flex-col items-center gap-2 py-10 text-center">
      <Icon name="peoples" :size="24" class="text-line-2" />
      <p class="text-[12px] text-dim2">还没有编排运行。<br />在会话里发起「自动执行」，拆解出的子任务进度会实时出现在这里。</p>
    </div>

    <div class="flex flex-col gap-2.5">
      <PlannerRunCard v-for="run in runsStore.runs" :key="run.id" :run="run" />
    </div>
  </section>
</template>
