<script setup lang="ts">
import { TabsList, TabsRoot, type TabsRootProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { cn } from "../../../lib/utils";

const props = withDefaults(
  defineProps<{
    modelValue?: TabsRootProps["modelValue"];
    variant?: "segment" | "line";
    class?: HTMLAttributes["class"];
  }>(),
  { variant: "line" },
);

const emit = defineEmits<{ (event: "update:modelValue", value: string): void }>();
</script>

<template>
  <TabsRoot :model-value="modelValue" @update:model-value="(value) => emit('update:modelValue', String(value))">
    <TabsList
      :class="
        cn(
          variant === 'segment'
            ? 'inline-flex items-center gap-1 rounded-full border border-border bg-secondary p-1'
            : 'flex items-center gap-5 border-b border-border',
          props.class,
        )
      "
    >
      <slot name="triggers" />
    </TabsList>
    <slot />
  </TabsRoot>
</template>

<script lang="ts">
export interface TabItem {
  value: string;
  label: string;
}

export const segmentTriggerClass =
  "rounded-full px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm focus:outline-none";

export const lineTriggerClass =
  "-mb-px border-b-2 border-transparent pb-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground focus:outline-none";
</script>
