<script setup lang="ts">
/**
 * GwButton —— 本项目按钮基座（基于 shadcn 的组件机制：reka `Primitive` + `cn`，
 * 配方见 `gw-button-variants.ts`）。统一焦点环 / disabled / 过渡等普适行为，视觉走
 * variant·size·radius 三轴；一次性样式通过 `class` 叠加（twMerge 收口）。
 *
 * `as` / `asChild` 透传给 Primitive：默认渲染 <button>，需要别的标签（a / RouterLink）
 * 时传 `as`，或 `as-child` 把样式贴到唯一子节点上。
 */
import type { PrimitiveProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { Primitive } from "reka-ui";
import { cn } from "@/lib/utils";
import { gwButtonVariants, type GwButtonVariants } from "./gw-button-variants";

interface Props extends PrimitiveProps {
  variant?: GwButtonVariants["variant"];
  size?: GwButtonVariants["size"];
  radius?: GwButtonVariants["radius"];
  class?: HTMLAttributes["class"];
}

const props = withDefaults(defineProps<Props>(), {
  as: "button",
});
</script>

<template>
  <Primitive
    data-slot="gw-button"
    :data-variant="variant"
    :data-size="size"
    :as="as"
    :as-child="asChild"
    :class="cn(gwButtonVariants({ variant, size, radius }), props.class)"
  >
    <slot />
  </Primitive>
</template>
