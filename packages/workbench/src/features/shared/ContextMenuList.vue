<script setup lang="ts">
/**
 * 把 lib/context-menu 的条目表渲染成 reka 菜单项。
 *
 * 只做扁平渲染（无子菜单）：子菜单在 happy-dom 里靠 hover 打开不可测，
 * 而本项目的菜单项都是单层的，没必要为此引入一层不可测结构。
 * 尺寸沿用右栏 / 活动带的紧凑规格（h-7 · 12px），与 dropdown-menu 的用法一致。
 */
import Icon from "@/features/shared/Icon.vue";
import { ContextMenuItem as ContextMenuItemPrimitive, ContextMenuLabel, ContextMenuSeparator } from "@/components/ui/context-menu";
import type { ContextMenuItem } from "@/lib/context-menu";

defineProps<{ items: readonly ContextMenuItem[] }>();
</script>

<template>
  <template v-for="(entry, index) in items" :key="index">
    <ContextMenuSeparator v-if="entry.kind === 'separator'" class="bg-line-2" />
    <ContextMenuLabel v-else-if="entry.kind === 'label'" class="px-2 py-1 text-[11px] text-dim2">
      {{ entry.label }}
    </ContextMenuLabel>
    <ContextMenuItemPrimitive
      v-else
      data-testid="context-menu-item"
      :disabled="entry.disabled"
      :variant="entry.destructive ? 'destructive' : 'default'"
      :class="['h-7 cursor-pointer rounded-[5px] px-2 text-[12px]', entry.destructive ? '' : 'text-dim focus:text-foreground']"
      @select="entry.onSelect()"
    >
      <Icon v-if="entry.icon" :name="entry.icon" :size="13" />
      <span class="min-w-0 flex-1 truncate">{{ entry.label }}</span>
    </ContextMenuItemPrimitive>
  </template>
</template>
