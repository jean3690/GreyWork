<script setup lang="ts">
import Icon from "./Icon.vue";
// 标识自带浅色底（源图就是深色乌鸦 + 浅底），所以这里不给容器上色，只做圆角裁切。
import logoUrl from "../assets/logo.svg?url";

/** 侧栏顶部：品牌标识 + 新对话。会话创建归外壳统一处理，这里只发意图。 */
const props = defineProps<{ collapsed: boolean }>();

const emit = defineEmits<{ newChat: [] }>();
</script>

<template>
  <div class="flex h-[52px] shrink-0 items-center justify-between gap-1 px-2">
    <div class="flex min-w-0 items-center gap-2 px-1.5">
      <img :src="logoUrl" alt="GreyWork" class="size-7 shrink-0 rounded-[8px]" width="28" height="28" />
      <span v-if="!props.collapsed" class="truncate font-display text-[14px] font-semibold tracking-tight text-foreground"> GreyWork </span>
    </div>

    <button
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-[8px] bg-accent px-2 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      aria-label="新建对话"
      @click="emit('newChat')"
    >
      <Icon name="plus" :size="14" />
      <span v-if="!props.collapsed">新对话</span>
    </button>
  </div>
</template>
