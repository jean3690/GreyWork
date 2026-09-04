<script setup lang="ts">
import Icon from "./Icon.vue";

/** 侧栏底部：主题切换 + 设置入口 + 用户块。theme 为 "dark"|"light"|"system"。 */
defineProps<{ theme: string }>();

const emit = defineEmits<{ toggleTheme: []; navigate: [path: string] }>();

/** 行按钮统一样式：34px 高、8px 圆角，与 GreyWork Sider 一致。 */
const rowClass =
  "flex h-[34px] cursor-pointer items-center gap-2 rounded-[8px] px-2 text-[13px] transition-colors text-dim hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";
</script>

<template>
  <div class="flex shrink-0 flex-col gap-0.5 border-t border-line-2 p-2">
    <button :class="rowClass" @click="emit('toggleTheme')">
      <span class="grid size-5 place-items-center rounded-[5px] bg-panel text-dim">
        <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="14" />
      </span>
      <span>{{ theme === "dark" ? "浅色模式" : "深色模式" }}</span>
    </button>

    <button :class="rowClass" @click="emit('navigate', '/settings/appearance')">
      <span class="grid size-5 place-items-center rounded-[5px] bg-panel text-dim">
        <Icon name="setting" :size="14" />
      </span>
      设置
      <Icon name="right" :size="12" class="ml-auto text-dim2" />
    </button>

    <button :class="rowClass" @click="emit('navigate', '/assistants')">
      <span class="grid size-5 shrink-0 place-items-center rounded-full bg-panel font-medium text-dim">
        <span class="text-[10px]">你</span>
      </span>
      用户
    </button>
  </div>
</template>
