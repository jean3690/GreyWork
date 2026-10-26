<script setup lang="ts">
/**
 * CSV 预览：表格 / 分析 / 地图三种模式。
 *
 * 表格模式只渲染前 500 行（见 `GridTable` 的说明）；分析模式的统计与图表基于**全部**
 * 已解析行 —— 「看得少」不等于「算得少」，两条口径刻意分开。
 *
 * **地图模式只在表头认出经纬度列时提供**（lon/lng/long/latitude/x/y/经度/纬度，见
 * `lib/csv-geo.ts`）：认不出就不摆入口，而不是给一个点了没反应的按钮。点位直接复用
 * `MapViewer`（同一套属性卡 / 图层开关 / 质控提示），坐标列之外的所有列都成为属性。
 *
 * 分析面板与地图都用 `defineAsyncComponent`：ECharts 与 MapLibre 都是重包，同步 import
 * 会让从不切过去的用户也付这份解析代价（`PreviewSurface` 已按 kind 分包，别破坏它）。
 */
import { computed, defineAsyncComponent, toRef } from "vue";
import { useI18n } from "vue-i18n";
import GridTable from "@/features/preview/GridTable.vue";
import PreviewModeSwitch from "@/features/preview/PreviewModeSwitch.vue";
import { parseCsv, splitHeader } from "@/lib/csv";
import { csvToPointCollection } from "@/lib/csv-geo";
import { usePreviewText } from "@/lib/preview-content";
import { usePreviewStore, type PreviewMode, type PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { t } = useI18n();
const preview = usePreviewStore();

const AnalysisPanel = defineAsyncComponent(() => import("@/features/preview/DataAnalysisPanel.vue"));
const CsvMap = defineAsyncComponent(() => import("@/features/preview/MapViewer.vue"));

const { data, loading, error } = usePreviewText(toRef(props, "tab"));

const table = computed(() => splitHeader(parseCsv(data.value ?? "")));
const geo = computed(() => csvToPointCollection(table.value.header, table.value.body));
const mode = computed<PreviewMode>(() => props.tab.mode ?? "table");
/** 存下的 mode 可能是 map，但当前数据认不出坐标列（文件被改过）—— 回落到表格。 */
const effectiveMode = computed<PreviewMode>(() => (mode.value === "map" && !geo.value ? "table" : mode.value));

function setMode(next: PreviewMode): void {
  preview.setMode(props.tab.id, next);
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">{{ tab.name }}</span>
      <PreviewModeSwitch :model-value="effectiveMode" :map="geo !== null" @update:model-value="setMode" />
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.common.loading") }}</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-orange">
      {{ t("preview.common.readFailed", { detail: error }) }}
    </p>
    <template v-else>
      <GridTable v-if="effectiveMode === 'table'" class="min-h-0 flex-1" :header="table.header" :rows="table.body" />
      <AnalysisPanel v-else-if="effectiveMode === 'analysis'" class="min-h-0 flex-1" :tab="tab" />
      <div v-else-if="geo" class="flex min-h-0 flex-1 flex-col">
        <p
          v-if="geo.skipped"
          data-testid="csv-map-skipped"
          class="shrink-0 border-b border-line bg-panel-2/60 px-3 py-1 text-[11px] text-dim"
        >
          {{ t("preview.csvMap.skipped", { count: geo.skipped }) }}
        </p>
        <CsvMap :tab="tab" :features="geo.collection" class="min-h-0 flex-1" />
      </div>
    </template>
  </div>
</template>
