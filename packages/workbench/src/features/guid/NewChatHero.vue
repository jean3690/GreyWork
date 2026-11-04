<script setup lang="ts">
/**
 * 新对话空态（Codex 形态）：居中标题 + 一行说明 + 可选建议行。
 *
 * 两处入口共用同一套排版：`GuidView`（默认插槽放输入卡）与 `ConversationView` 的空会话
 * （输入卡在页脚，本组件只出标题与建议）。文案由调用方 `t()` 后传入 —— 组件不持有 key，
 * 避免同一套 key 在两边各解析一次。
 */
import Icon from "@/features/shared/Icon.vue";

interface HeroSuggestion {
  icon: string;
  label: string;
  /** 右侧一句说明，窄屏会被截断；缺省时只显示标题。 */
  description?: string;
  /** 点击后填进输入框的正文。 */
  value: string;
}

defineProps<{
  title: string;
  hint: string;
  suggestions?: readonly HeroSuggestion[];
}>();

const emit = defineEmits<{ pick: [value: string] }>();
</script>

<template>
  <div class="flex w-full flex-col items-center">
    <div class="w-full text-center">
      <h1 class="font-display text-[22px] font-medium tracking-tight text-foreground">{{ title }}</h1>
      <p class="mx-auto mt-1.5 max-w-[460px] text-[12.5px] leading-relaxed text-dim2">{{ hint }}</p>
    </div>

    <!-- 输入卡（GuidView 用；对话页的输入卡常驻页脚，不传插槽） -->
    <div v-if="$slots.default" class="mt-6 w-full">
      <slot />
    </div>

    <div v-if="suggestions?.length" class="mt-3 grid w-full gap-1">
      <button
        v-for="suggestion in suggestions"
        :key="suggestion.value"
        type="button"
        data-testid="composer-suggestion"
        class="group/s flex w-full cursor-pointer items-center gap-2 rounded-[calc(9px*var(--gw-radius-scale))] px-2.5 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        @click="emit('pick', suggestion.value)"
      >
        <Icon :name="suggestion.icon" :size="13" class="shrink-0 text-dim2 transition-colors group-hover/s:text-foreground" />
        <span class="shrink-0 text-[12.5px] text-foreground">{{ suggestion.label }}</span>
        <span v-if="suggestion.description" class="min-w-0 flex-1 truncate text-[11.5px] text-dim2">
          {{ suggestion.description }}
        </span>
        <span v-else class="flex-1" />
        <Icon name="right" :size="12" class="shrink-0 text-dim2 opacity-0 transition-opacity group-hover/s:opacity-100" />
      </button>
    </div>
  </div>
</template>
