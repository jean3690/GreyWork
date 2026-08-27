<script setup lang="ts">
import { computed, ref } from "vue";
import Button from "./Button.vue";

/** shadcn 风格文件选择：Button + 隐藏 input[type=file]（shadcn 无 Upload 原语的惯用替代）。 */
const props = defineProps<{
  accept?: string;
  label?: string;
  variant?: "default" | "secondary" | "outline" | "ghost";
  size?: "default" | "sm" | "lg";
}>();

const emit = defineEmits<{ (event: "select", file: File): void }>();

const inputRef = ref<HTMLInputElement | null>(null);

const buttonLabel = computed(() => props.label ?? "选择文件");

function open(): void {
  inputRef.value?.click();
}

function onChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit("select", file);
  input.value = "";
}
</script>

<template>
  <Button :variant="props.variant ?? 'outline'" :size="props.size ?? 'sm'" @click="open">
    <slot>{{ buttonLabel }}</slot>
    <input ref="inputRef" type="file" :accept="props.accept" class="hidden" @change="onChange" />
  </Button>
</template>
