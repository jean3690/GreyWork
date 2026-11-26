<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <div
    data-slot="input-group"
    role="group"
    :class="
      cn(
        'group/input-group border-input dark:bg-input/30 relative flex w-full items-center rounded-md border shadow-xs transition-colors outline-none',
        'h-9 min-w-0 has-[>textarea]:h-auto',

        // Variants based on alignment.
        'has-[>[data-align=inline-start]]:[&>input]:pl-2',
        'has-[>[data-align=inline-end]]:[&>input]:pr-2',
        'has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:[&>input]:pb-3',
        'has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-3',

        // 与独立输入框一致：仅外层边框响应焦点，不再叠加一圈光圈。
        'has-[[data-slot=input-group-control]:focus-visible]:border-ring',

        // Error state.
        'has-[[data-slot][aria-invalid=true]]:border-destructive',

        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
