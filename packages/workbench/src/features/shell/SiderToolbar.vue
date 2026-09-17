<script setup lang="ts">
// 标识自带浅色底（源图就是深色乌鸦 + 浅底），所以这里不给容器上色，只做圆角裁切。
import logoUrl from "@/assets/logo.svg?url";
/** 侧栏品牌入口：点击在完整侧栏与图标轨道间切换。 */
const props = defineProps<{ collapsed: boolean }>();

const emit = defineEmits<{ toggleSider: [] }>();
</script>

<template>
  <div class="flex h-[52px] shrink-0 items-center px-2">
    <button
      class="flex h-9 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-[8px] px-1.5 text-left transition-colors hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      :class="props.collapsed ? 'justify-center px-0' : ''"
      :aria-label="props.collapsed ? '展开侧栏' : '收起侧栏'"
      data-testid="sider-brand-toggle"
      @click="emit('toggleSider')"
    >
      <img :src="logoUrl" alt="" class="size-7 shrink-0 rounded-[8px]" width="28" height="28" />
      <span v-if="!props.collapsed" class="truncate font-display text-[14px] font-semibold tracking-tight text-foreground"> GreyWork </span>
    </button>
  </div>
</template>
