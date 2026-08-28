<script setup lang="ts">
import { SelectContent, SelectItem, SelectItemText, SelectPortal, SelectRoot, SelectTrigger, SelectValue } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { computed } from "vue";
import { ChevronDown } from "lucide-vue-next";
import { cn } from "../../../lib/utils";

export interface SelectOption {
  label: string;
  value: string;
}

const props = withDefaults(
  defineProps<{
    options?: SelectOption[];
    modelValue?: string;
    placeholder?: string;
    disabled?: boolean;
    triggerClass?: HTMLAttributes["class"];
    contentClass?: HTMLAttributes["class"];
  }>(),
  { options: () => [] },
);

const emit = defineEmits<{ (event: "update:modelValue", value: string): void }>();

const selected = computed({
  get: () => props.modelValue,
  set: (value: string | undefined) => {
    if (value !== undefined) emit("update:modelValue", value);
  },
});
</script>

<template>
  <SelectRoot v-model="selected" :disabled="props.disabled">
    <SelectTrigger
      :class="
        cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 text-sm text-foreground whitespace-nowrap transition-colors focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50 data-[placeholder]:text-muted-foreground',
          props.triggerClass,
        )
      "
    >
      <SelectValue :placeholder="props.placeholder ?? '请选择'" />
      <ChevronDown class="size-4 shrink-0 text-muted-foreground" />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="6"
        :class="
          cn(
            'z-50 max-h-72 min-w-[10rem] overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-[0_16px_44px_rgba(17,17,20,0.14)]',
            props.contentClass,
          )
        "
      >
        <SelectItem
          v-for="option in props.options"
          :key="option.value"
          :value="option.value"
          class="cursor-pointer rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors focus:bg-accent data-[state=checked]:bg-accent data-[state=checked]:font-medium"
        >
          <SelectItemText>{{ option.label }}</SelectItemText>
        </SelectItem>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
