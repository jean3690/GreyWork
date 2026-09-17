<script setup lang="ts">
/**
 * 团队页 · planner 编排单条运行卡片：状态徽章、子任务神态、完成进度。
 */
import { computed } from "vue";
import Icon from "@/features/shared/Icon.vue";
import type { PlannerRun, Subtask } from "@greywork/agents";

const props = defineProps<{ run: PlannerRun }>();

const runStatusMeta: Record<PlannerRun["status"], { label: string; badge: string }> = {
  planning: { label: "规划中", badge: "bg-cyan/10 text-cyan" },
  running: { label: "执行中", badge: "bg-amber/10 text-amber" },
  done: { label: "已完成", badge: "bg-mint/10 text-mint" },
  failed: { label: "失败", badge: "bg-destructive/10 text-destructive" },
};

const subStatusMeta: Record<Subtask["status"], { dot: string; label: string }> = {
  pending: { dot: "bg-line-2", label: "待派" },
  running: { dot: "bg-amber", label: "执行" },
  done: { dot: "bg-mint", label: "完成" },
  failed: { dot: "bg-destructive", label: "失败" },
};

const doneCount = computed(() => props.run.subtasks.filter((sub) => sub.status === "done").length);

const progress = computed(() => (props.run.subtasks.length ? `${(doneCount.value / props.run.subtasks.length) * 100}%` : "0%"));

function timeOf(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    planner: "规划",
    researcher: "调研",
    builder: "执行",
    "geo-analyst": "地理",
    "spatial-artist": "制图",
    reviewer: "审查",
  };
  return labels[role] ?? role;
}
</script>

<template>
  <article class="rounded-[14px] border border-line bg-panel p-3.5">
    <div class="flex items-start gap-2.5">
      <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-[8px] bg-panel-2 text-dim">
        <Icon name="peoples" :size="14" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="rounded-full px-2 py-0.5 text-[10px] font-medium" :class="runStatusMeta[run.status].badge">
            {{ runStatusMeta[run.status].label }}
          </span>
          <span class="text-[10px] text-dim2">{{ timeOf(run.createdAt) }}</span>
        </div>
        <div class="mt-1 truncate text-[13px] font-medium text-foreground">{{ run.goal }}</div>

        <div class="mt-2 flex flex-wrap gap-1.5">
          <span
            v-for="sub in run.subtasks"
            :key="sub.id"
            class="flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[10px] text-dim"
          >
            <span class="size-1.5 rounded-full" :class="subStatusMeta[sub.status].dot" />
            {{ roleLabel(sub.role) }} · {{ subStatusMeta[sub.status].label }}
          </span>
        </div>

        <div v-if="run.subtasks.length" class="mt-2.5 flex items-center gap-2">
          <div class="h-1 flex-1 overflow-hidden rounded-full bg-panel-2">
            <div class="h-full rounded-full bg-accent transition-[width]" :style="{ width: progress }" />
          </div>
          <span class="text-[10px] tabular-nums text-dim2">{{ doneCount }}/{{ run.subtasks.length }}</span>
        </div>
      </div>
    </div>
  </article>
</template>
