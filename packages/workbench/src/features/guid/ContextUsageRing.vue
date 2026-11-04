<script setup lang="ts">
/**
 * 上下文占用指示（输入卡底排）。
 *
 * 数据源是 ACP 的 `usage` 事件（`agent.acpUsage = { used, size }`）；本地 LLM 路由没有这条
 * 信息，因此无值时不渲染 —— 不留一个永远 0% 的假指示。
 *
 * 形态刻意做小：14px 圆环 + 百分比。70% 起转 amber、90% 起转 orange，颜色只承担告警，
 * 常态是 `--dim2`，不抢发送键的视觉权重。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useAgentStore } from "@/stores/agent";
import Hint from "@/features/shared/Hint.vue";

const agent = useAgentStore();
const { t } = useI18n();

/** token 数缩写：24800 → 24.8k，1200000 → 1.2M。 */
function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

const percent = computed(() => {
  const usage = agent.acpUsage;
  if (!usage || !usage.size) return null;
  return Math.max(0, Math.min(100, Math.round((usage.used / usage.size) * 100)));
});

const tone = computed(() => {
  const value = percent.value ?? 0;
  if (value >= 90) return "var(--orange)";
  if (value >= 70) return "var(--amber)";
  return "var(--dim2)";
});

const hint = computed(() => {
  const usage = agent.acpUsage;
  if (!usage || percent.value === null) return "";
  return t("minimal.contextUsage", { used: compact(usage.used), size: compact(usage.size), percent: percent.value });
});
</script>

<template>
  <Hint v-if="percent !== null" :text="hint">
    <span
      data-testid="context-usage"
      class="flex h-7 shrink-0 cursor-default items-center gap-1 px-1 text-[10.5px] text-dim2"
      :aria-label="hint"
    >
      <span
        class="grid size-3.5 place-items-center rounded-full"
        :style="{ background: `conic-gradient(${tone} ${percent}%, var(--line-2) 0)` }"
      >
        <span class="size-2 rounded-full bg-panel" />
      </span>
      {{ percent }}%
    </span>
  </Hint>
</template>
