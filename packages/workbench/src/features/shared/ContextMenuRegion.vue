<script setup lang="ts">
/**
 * 通用右键区域：把一个**单根**元素变成 reka ContextMenu 的 trigger。
 *
 * asChild 下 reka 把监听合并到 slot 根元素上，不产生额外 DOM —— 既有 data-testid、
 * 布局与测试都不受影响（这也是选它而不是「自己套一层 div」的原因）。
 *
 * 区域的 build 回调按命中的 `[data-ctx]` 目标返回条目表；返回空数组即抑制本次右键。
 *
 * 两条来自 reka 实现的硬约束（改动前先看 lib/context-menu.ts 顶部注释）：
 * - **有**条目时绝不能 preventDefault：reka 在 `await nextTick()` 之后才检查
 *   `event.defaultPrevented`，被拦掉就整段跳过，菜单不会打开。
 * - 区域之间**不得嵌套**：ContextMenuTrigger 不做 stopPropagation，嵌套会让内外两个
 *   root 同时打开。
 */
import { ref } from "vue";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import ContextMenuList from "@/features/shared/ContextMenuList.vue";
import { contextTarget, type ContextMenuItem, type ContextTarget } from "@/lib/context-menu";

const props = defineProps<{
  /** 依据命中的目标构建条目；返回 [] 表示该处不弹菜单（同时拦掉原生菜单）。 */
  build: (target: ContextTarget | null) => ContextMenuItem[];
}>();

const items = ref<ContextMenuItem[]>([]);

function capture(event: MouseEvent): void {
  const next = props.build(contextTarget(event.target));
  items.value = next;
  // 空菜单：主动拦掉 —— 既不弹空壳，也顺手拦掉原生右键菜单。
  if (next.length === 0) event.preventDefault();
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child @contextmenu="capture">
      <slot />
    </ContextMenuTrigger>
    <ContextMenuContent data-testid="context-menu-content" class="min-w-[168px] border-line-2 bg-popover p-1">
      <ContextMenuList :items="items" />
    </ContextMenuContent>
  </ContextMenu>
</template>
