<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { LAYOUT_MODES, slotsOf, type LayoutMode } from "../lib/layout-modes";
import { useLayoutStore } from "../stores/layout";

/**
 * 布局模式指示器：把四种布局画成「哪几个面板在场」的三段读数。
 *
 * **用槽位图而不是文字名**，是因为它直接编码了真实信息 —— 面板在不在场，
 * 一眼可读、跨语言可读；模式名只放在 title / aria-label 里。缺位的槽留空而不是
 * 画个幽灵格，四个格子的槽位坐标才保持一致，「左两段」与「右两段」才分得开。
 *
 * 它与 Ctrl+1~4 读同一份状态（`layout.mode`），所以它首先是**指示器**，其次才是按钮组 ——
 * 用户用 Ctrl+B 改了布局，这里的高亮会跟着走，不会出现「指示器说三栏、实际只剩一个面板」。
 *
 * 只用语义 token（panel / cyan / dim2），深浅两态都要成立；分段图形不带文字，
 * 42px 的标题栏里放四个文字标签会挤成一团。
 */
const { t } = useI18n();
const layout = useLayoutStore();

const items = computed(() =>
  LAYOUT_MODES.map((mode: LayoutMode, index) => {
    const label = t(`layout.mode.${mode}`);
    return {
      mode,
      slots: slotsOf(mode),
      label,
      title: `${label} · Ctrl+${index + 1}`,
      active: layout.mode === mode,
    };
  }),
);

/** 槽位的视觉宽度：中槽（内容区）最宽，左右两槽窄一点，读起来像一扇真实的窗。 */
const SLOT_WIDTH = ["w-[4px]", "w-[6px]", "w-[4px]"] as const;
</script>

<template>
  <div class="flex items-center gap-0.5" role="group" :aria-label="t('layout.groupLabel')">
    <button
      v-for="item in items"
      :key="item.mode"
      type="button"
      class="grid h-[22px] w-[26px] cursor-pointer place-items-center rounded-[6px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      :class="item.active ? 'bg-panel' : 'hover:bg-panel'"
      :aria-pressed="item.active"
      :aria-label="item.label"
      :title="item.title"
      :data-testid="`layout-mode-${item.mode}`"
      @click="layout.applyMode(item.mode)"
    >
      <span class="flex items-center gap-[2px]" aria-hidden="true">
        <span
          v-for="(present, slot) in [item.slots.left, item.slots.center, item.slots.right]"
          :key="slot"
          class="h-[8px] rounded-[1.5px] transition-colors"
          :class="[SLOT_WIDTH[slot], present ? (item.active ? 'bg-cyan' : 'bg-dim2') : 'bg-transparent']"
        />
      </span>
    </button>
  </div>
</template>
