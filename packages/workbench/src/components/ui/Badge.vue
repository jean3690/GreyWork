<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors", {
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground",
      secondary: "border-transparent bg-secondary text-secondary-foreground",
      outline: "border-border text-muted-foreground",
      success: "border-transparent bg-emerald-100 text-emerald-700",
      warning: "border-transparent bg-amber-100 text-amber-700",
      destructive: "border-transparent bg-red-100 text-red-700",
      info: "border-transparent bg-blue-50 text-blue-600",
    },
  },
  defaultVariants: { variant: "secondary" },
});

const props = defineProps<{
  variant?: VariantProps<typeof badgeVariants>["variant"];
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <span :class="cn(badgeVariants({ variant }), props.class)"><slot /></span>
</template>
