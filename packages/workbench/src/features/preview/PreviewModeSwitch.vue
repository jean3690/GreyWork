<script setup lang="ts">
/**
 * 「表格 / 分析 / 地图」模式切换（分段控件）。
 *
 * 纯展示（`modelValue` + `update:modelValue`），不读 store —— 三个 viewer 都要用它，
 * 谁持有模式状态由调用点决定，组件不必知道。样式对齐 PreviewSider 的区段切换条。
 *
 * `map` 只在当前文件真的能画地图时（CSV 里认出了经纬度列）才给：留一个点了没反应的
 * 选项，比不摆更糟。
 */
import { useI18n } from "vue-i18n";
import type { PreviewMode } from "@/stores/preview";

defineProps<{ modelValue: PreviewMode; map?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: PreviewMode] }>();

const { t } = useI18n();

function optionClass(active: boolean): string {
  return [
    "h-5 shrink-0 cursor-pointer rounded-[calc(5px*var(--gw-radius-scale))] px-2 text-[11px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    active ? "bg-panel text-foreground" : "text-dim hover:text-foreground",
  ].join(" ");
}
</script>

<template>
  <div
    class="flex shrink-0 items-center gap-0.5 rounded-[calc(7px*var(--gw-radius-scale))] border border-line-2 bg-panel-2 p-0.5"
    role="group"
    :aria-label="t('preview.mode.label')"
  >
    <button
      type="button"
      data-testid="preview-mode-table"
      :class="optionClass(modelValue === 'table')"
      :aria-pressed="modelValue === 'table'"
      @click="emit('update:modelValue', 'table')"
    >
      {{ t("preview.mode.table") }}
    </button>
    <button
      type="button"
      data-testid="preview-mode-analysis"
      :class="optionClass(modelValue === 'analysis')"
      :aria-pressed="modelValue === 'analysis'"
      @click="emit('update:modelValue', 'analysis')"
    >
      {{ t("preview.mode.analysis") }}
    </button>
    <button
      v-if="map"
      type="button"
      data-testid="preview-mode-map"
      :class="optionClass(modelValue === 'map')"
      :aria-pressed="modelValue === 'map'"
      @click="emit('update:modelValue', 'map')"
    >
      {{ t("preview.mode.map") }}
    </button>
  </div>
</template>
