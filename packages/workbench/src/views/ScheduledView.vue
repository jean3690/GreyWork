<script setup lang="ts">
import { useAutomationStore } from "../stores/automation";
import Icon from "../components/Icon.vue";

/** 定时任务页：automation store 清单 + 启停 + 立即运行 + 新建。 */
const automation = useAutomationStore();

function fmtLastRun(ts: number): string {
  if (!ts) return "从未运行";
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
</script>

<template>
  <section class="mx-auto min-h-0 w-full max-w-[860px] overflow-y-auto px-4 py-6 sm:px-6">
    <div class="mb-5 flex items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">定时任务</h1>
        <p class="mt-1 text-[12px] text-dim2">按时或按规则触发，无人值守执行。</p>
      </div>
      <button
        class="flex h-8 cursor-pointer items-center gap-1.5 rounded-[10px] bg-console px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
        @click="automation.add()"
      >
        <Icon name="plus" :size="13" />
        新建任务
      </button>
    </div>

    <div class="flex flex-col gap-2">
      <article
        v-for="task in automation.list"
        :key="task.id"
        class="flex items-center gap-3 rounded-[14px] border border-line bg-panel p-3.5"
        :class="{ 'opacity-60': !task.enabled }"
      >
        <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-panel-2 text-dim">
          <Icon name="alarm-clock" :size="16" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-[13px] font-medium text-foreground">{{ task.name }}</span>
            <span class="shrink-0 rounded-full bg-panel-2 px-2 py-0.5 text-[10px] text-dim2">{{ task.schedule }}</span>
          </div>
          <div class="mt-0.5 truncate text-[11px] text-dim2">{{ task.intent }}</div>
          <div class="mt-0.5 text-[10px] text-dim2">上次运行：{{ fmtLastRun(task.lastRun) }}</div>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          <button
            class="flex h-7 cursor-pointer items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
            :disabled="task.running || automation.list.some((a) => a.running)"
            @click="automation.runNow(task.id)"
          >
            <Icon name="lightning" :size="12" />
            {{ task.running ? "运行中" : "立即运行" }}
          </button>
          <button
            class="grid size-7 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
            :aria-label="task.enabled ? '停用' : '启用'"
            @click="automation.setEnabled(task.id, !task.enabled)"
          >
            <Icon :name="task.enabled ? 'check-one' : 'close-one'" :size="14" />
          </button>
          <button
            class="grid size-7 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
            aria-label="删除任务"
            @click="automation.remove(task.id)"
          >
            <Icon name="delete" :size="14" />
          </button>
        </div>
      </article>
    </div>

    <p v-if="automation.list.length === 0" class="py-16 text-center text-[12px] text-dim2">还没有定时任务。</p>
  </section>
</template>
