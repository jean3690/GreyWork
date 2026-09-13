<script setup lang="ts">
import { computed } from "vue";
import type { RenderCommand } from "../plugins/render-commands";

/**
 * 指令集 → SVG 渲染：纯展示组件，一个指令一个元素。
 * 指令已过 validateRenderCommands 白名单，这里只做映射。
 */
const props = defineProps<{
  commands: readonly RenderCommand[];
  width: number;
  height: number;
}>();

const viewBox = computed(() => `0 0 ${props.width} ${props.height}`);

function styleOf(command: RenderCommand): Record<string, string> {
  const style: Record<string, string> = {};
  if ("fill" in command && command.fill !== undefined) style.fill = command.fill;
  if ("stroke" in command && command.stroke !== undefined) style.stroke = command.stroke;
  if ("strokeWidth" in command && command.strokeWidth !== undefined) style["stroke-width"] = String(command.strokeWidth);
  if ("opacity" in command && command.opacity !== undefined) style.opacity = String(command.opacity);
  return style;
}

function transformOf(command: Extract<RenderCommand, { kind: "group" }>): string {
  const parts: string[] = [];
  if (command.translate) parts.push(`translate(${command.translate[0]} ${command.translate[1]})`);
  if (command.rotate !== undefined) parts.push(`rotate(${command.rotate})`);
  if (command.scale !== undefined) parts.push(`scale(${command.scale})`);
  return parts.join(" ");
}
</script>

<template>
  <svg :viewBox="viewBox" :width="width" :height="height" role="img" data-testid="plugin-render-canvas" class="overflow-visible">
    <template v-for="(command, index) in commands" :key="index">
      <circle v-if="command.kind === 'circle'" :cx="command.cx" :cy="command.cy" :r="command.r" v-bind="styleOf(command)" />
      <ellipse
        v-else-if="command.kind === 'ellipse'"
        :cx="command.cx"
        :cy="command.cy"
        :rx="command.rx"
        :ry="command.ry"
        v-bind="styleOf(command)"
      />
      <rect
        v-else-if="command.kind === 'rect'"
        :x="command.x"
        :y="command.y"
        :width="command.w"
        :height="command.h"
        :rx="command.rx ?? 0"
        v-bind="styleOf(command)"
      />
      <path v-else-if="command.kind === 'path'" :d="command.d" v-bind="styleOf(command)" />
      <text v-else-if="command.kind === 'text'" :x="command.x" :y="command.y" :font-size="command.fontSize ?? 14" v-bind="styleOf(command)">
        {{ command.text }}
      </text>
      <g v-else-if="command.kind === 'group'" :transform="transformOf(command)">
        <PluginRenderCanvas :commands="command.children" :width="width" :height="height" />
      </g>
    </template>
  </svg>
</template>
