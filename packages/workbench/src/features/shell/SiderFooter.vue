<script setup lang="ts">
import { useI18n } from "vue-i18n";
import Icon from "@/features/shared/Icon.vue";

const { t } = useI18n();

const emit = defineEmits<{ openSettings: []; navigate: [path: string] }>();

/** 行按钮统一样式：34px 高、8px 圆角，与 GreyWork Sider 一致。 */
const rowClass =
  "flex h-[34px] cursor-pointer items-center gap-2 rounded-[8px] px-2 text-[13px] transition-colors text-dim hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";
</script>

<template>
  <div class="flex shrink-0 flex-col gap-0.5 border-t border-line-2 p-2">
    <button :class="rowClass" data-testid="sider-settings" @click="emit('openSettings')">
      <span class="grid size-5 place-items-center rounded-[5px] bg-panel text-dim">
        <Icon name="setting" :size="14" />
      </span>
      {{ t(`settings.title`) }}
    </button>

    <button :class="rowClass" @click="emit('navigate', '/assistants')">
      <span class="grid size-5 shrink-0 place-items-center rounded-full bg-panel font-medium text-dim">
        <span class="text-[10px]">你</span>
      </span>
      用户
    </button>
  </div>
</template>
