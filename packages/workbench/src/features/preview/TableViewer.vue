<script setup lang="ts">
/**
 * CSV 预览：表格 / 分析双模式。
 *
 * 表格模式只渲染前 500 行（见 `GridTable` 的说明）；分析模式的统计与图表基于**全部**
 * 已解析行 —— 「看得少」不等于「算得少」，两条口径刻意分开。
 *
 * 分析面板用 `defineAsyncComponent`：它带着 ECharts，同步 import 会让从不切到分析的用户
 * 也付这份解析代价（`PreviewSurface` 已按 kind 分包，这里别破坏它）。
 */
import { computed, defineAsyncComponent, toRef } from "vue";
import { useI18n } from "vue-i18n";
import GridTable from "@/features/preview/GridTable.vue";
import PreviewModeSwitch from "@/features/preview/PreviewModeSwitch.vue";
import { parseCsv, splitHeader } from "@/lib/csv";
import { usePreviewText } from "@/lib/preview-content";
import { usePreviewStore, type PreviewMode, type PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { t } = useI18n();
const preview = usePreviewStore();

const AnalysisPanel = defineAsyncComponent(() => import("@/features/preview/DataAnalysisPanel.vue"));

const { data, loading, error } = usePreviewText(toRef(props, "tab"));

const table = computed(() => splitHeader(parseCsv(data.value ?? "")));
const mode = computed<PreviewMode>(() => props.tab.mode ?? "table");

function setMode(next: PreviewMode): void {
  preview.setMode(props.tab.id, next);
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">{{ tab.name }}</span>
      <PreviewModeSwitch :model-value="mode" @update:model-value="setMode" />
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.common.loading") }}</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-orange">
      {{ t("preview.common.readFailed", { detail: error }) }}
    </p>
    <template v-else>
      <GridTable v-if="mode === 'table'" class="min-h-0 flex-1" :header="table.header" :rows="table.body" />
      <AnalysisPanel v-else class="min-h-0 flex-1" :tab="tab" />
    </template>
  </div>
</template>
