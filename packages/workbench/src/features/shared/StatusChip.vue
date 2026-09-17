<script setup lang="ts">
/**
 * 彩色小胶囊：把「语义 → 颜色」的映射集中在一处，
 * 页面上各处（能力危险级别 / 审计结果 / 计数徽标）复用同一套态色。
 * 布局走默认（圆角 5px / text-[9px]），需要微调叠加 class 即可。
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** 语义态：ok/warn/denied 为 10% 底，high/medium/low 为 15% 底，panel 为中性灰。 */
    tone?: "ok" | "warn" | "denied" | "high" | "medium" | "low" | "panel";
    /** 圆角满率高亮徽标（计数这类）。 */
    pill?: boolean;
  }>(),
  { tone: "panel", pill: false },
);

const palette: Record<NonNullable<typeof props.tone>, string> = {
  ok: "bg-mint/10 text-mint",
  warn: "bg-amber/10 text-amber",
  denied: "bg-orange/10 text-orange",
  high: "bg-orange/15 text-orange",
  medium: "bg-amber/15 text-amber",
  low: "bg-mint/15 text-mint",
  panel: "bg-panel-2 text-dim2",
};

const chipClass = computed(() => palette[props.tone]);
</script>

<template>
  <span class="inline-flex items-center px-1.5 py-0.5 font-medium text-[9px]" :class="[pill ? 'rounded-full' : 'rounded-[5px]', chipClass]">
    <slot />
  </span>
</template>
