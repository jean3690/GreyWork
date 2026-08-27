<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "../../lib/utils";

const props = defineProps<{
  modelValue?: string | number;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  class?: HTMLAttributes["class"];
}>();

const emit = defineEmits<{ (event: "update:modelValue", value: string): void }>();

function onInput(event: Event): void {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
}
</script>

<template>
  <input
    :type="props.type ?? 'text'"
    :value="props.modelValue"
    :placeholder="props.placeholder"
    :disabled="props.disabled"
    :class="
      cn(
        'flex h-9 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm text-foreground shadow-none transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50',
        props.class,
      )
    "
    @input="onInput"
  />
</template>
