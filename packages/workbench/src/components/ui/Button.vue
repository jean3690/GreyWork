<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline: "border border-border bg-transparent text-foreground hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "text-foreground hover:bg-accent",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

const props = withDefaults(
  defineProps<{
    variant?: VariantProps<typeof buttonVariants>["variant"];
    size?: VariantProps<typeof buttonVariants>["size"];
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  { type: "button" },
);
</script>

<template>
  <button :type="props.type" :disabled="props.disabled" :class="cn(buttonVariants({ variant, size }), props.class)">
    <slot />
  </button>
</template>
