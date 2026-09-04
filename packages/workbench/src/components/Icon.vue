<script setup lang="ts">
import { computed } from "vue";
import { getIconShapes } from "../lib/icons";

/**
 * GreyWork 外壳图标：形状表在 icons.ts，此处只做 48 viewBox → 目标尺寸的渲染。
 * stroke 取 currentColor，所以配色靠外层 text-* 决定；aria-hidden 因为图标恒为装饰，
 * 语义由按钮自身的 aria-label 承担。
 */
const props = withDefaults(
  defineProps<{
    name: string;
    size?: number;
    strokeWidth?: number;
  }>(),
  { size: 18, strokeWidth: 2.5 },
);

const shapes = computed(() => getIconShapes(props.name));
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 48 48"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="inline-block shrink-0 align-middle"
    aria-hidden="true"
    focusable="false"
  >
    <template v-for="(shape, i) in shapes" :key="i">
      <path v-if="shape.kind === 'path'" :d="shape.d" />
      <line v-else-if="shape.kind === 'line'" :x1="shape.x1" :y1="shape.y1" :x2="shape.x2" :y2="shape.y2" />
      <circle
        v-else-if="shape.kind === 'circle'"
        :cx="shape.cx"
        :cy="shape.cy"
        :r="shape.r"
        :fill="shape.filled ? 'currentColor' : 'none'"
        :stroke="shape.filled ? 'none' : 'currentColor'"
      />
      <rect v-else :x="shape.x" :y="shape.y" :width="shape.w" :height="shape.h" />
    </template>
  </svg>
</template>
