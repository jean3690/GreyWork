<script setup lang="ts">
import { SwitchRoot, SwitchThumb, type SwitchRootProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { computed } from "vue";
import { cn } from "../../lib/utils";

const props = defineProps<{
  modelValue?: SwitchRootProps["modelValue"];
  disabled?: boolean;
  class?: HTMLAttributes["class"];
}>();

const emit = defineEmits<{ (event: "update:modelValue", value: boolean): void }>();

const model = computed({
  get: () => props.modelValue ?? false,
  set: (value: boolean) => emit("update:modelValue", value),
});
</script>

<template>
  <SwitchRoot
    v-model="model"
    :disabled="props.disabled"
    :class="
      cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        props.class,
      )
    "
  >
    <SwitchThumb
      :class="
        cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
        )
      "
    />
  </SwitchRoot>
</template>
