<script setup lang="ts">
import { TabsTrigger } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { cn } from "../../../lib/utils";

const props = defineProps<{
  value: string;
  disabled?: boolean;
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <TabsTrigger :value="props.value" :disabled="props.disabled" :class="cn('focus:outline-none', props.class)">
    <slot />
  </TabsTrigger>
</template>
