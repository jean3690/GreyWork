<script setup lang="ts">
/**
 * 斜杠命令菜单（纯展示）：锚在输入卡上方，焦点始终留在 textarea——
 * 高亮用 aria-activedescendant 表达，行内 mousedown.prevent 防止点击行时输入框失焦。
 */
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "@/features/shared/Icon.vue";
import { slashOptionId, type SlashCommandItem } from "@/lib/slash-commands";

const props = defineProps<{
  items: readonly SlashCommandItem[];
  activeIndex: number;
}>();

const emit = defineEmits<{
  (event: "select", index: number): void;
  (event: "update:activeIndex", index: number): void;
}>();

const { t } = useI18n();
const rootEl = ref<HTMLElement | null>(null);

// 键盘移动时把高亮行带进可视区（happy-dom 无 scrollIntoView 时静默跳过）。
watch(
  () => props.activeIndex,
  () => {
    const active = rootEl.value?.querySelector('[role="option"][aria-selected="true"]');
    (active as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  },
);
</script>

<template>
  <div
    id="slash-command-menu"
    ref="rootEl"
    data-testid="slash-menu"
    role="listbox"
    :aria-label="t('chat.slash.menuAria')"
    class="absolute bottom-full left-2 right-2 z-40 mb-2 max-h-[260px] overflow-y-auto rounded-[12px] border border-line bg-popover p-1 shadow-xl"
  >
    <p v-if="items.length === 0" class="px-2.5 py-2 text-[12px] text-dim2">{{ t("chat.slash.empty") }}</p>
    <button
      v-for="(item, index) in items"
      :id="slashOptionId(item)"
      :key="item.id"
      type="button"
      role="option"
      data-testid="slash-option"
      :aria-selected="index === activeIndex"
      class="flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-2 text-left transition-colors"
      :class="index === activeIndex ? 'bg-panel' : 'hover:bg-panel/60'"
      @mousedown.prevent
      @mouseenter="emit('update:activeIndex', index)"
      @click="emit('select', index)"
    >
      <span class="shrink-0 font-mono text-[12px] font-medium text-foreground">/{{ item.name }}</span>
      <span class="min-w-0 flex-1 truncate text-[11.5px] text-dim">{{ item.description }}</span>
      <span v-if="item.hint" class="shrink-0 text-[10.5px] text-dim2">{{ item.hint }}</span>
      <span
        v-if="item.builtinKind === 'template'"
        data-testid="slash-badge-template"
        class="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] text-dim2"
      >
        {{ t("chat.slash.badgeTemplate") }}
      </span>
      <Icon v-if="item.active" name="check" :size="12" class="shrink-0 text-cyan" />
    </button>
  </div>
</template>
