<script setup lang="ts">
/**
 * 分析图表（ECharts）。
 *
 * **懒加载边界**：本组件**静态** import ECharts，但只被 `defineAsyncComponent` 引入的
 * `DataAnalysisPanel` 引用 —— 于是 echarts 自然落在独立 chunk，从不切到分析模式的用户
 * 一分代价都不付（与 Univer / pdfjs 同一套分包策略，见 PreviewSurface 顶部注释）。
 *
 * **按需注册**：只 use 柱/折线/饼三种图与必要的组件，不引 `echarts` 全量入口 ——
 * 全量入口会把地图、3D、关系图一并捆进来。
 *
 * **配色不用 ECharts 自带主题**：它只分亮/暗两套，切到本仓的其它调色板（github / fox /
 * night-*）就会与界面脱节。改成从 CSS 变量读当前主题的色，外观切换时重取重绘。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { buildChartOption, buildChartSeries, type ChartConfig, type ChartPalette, type ChartType } from "@/lib/chart-options";
import { useTheme } from "@/lib/theme";
import type { Aggregation } from "@/lib/data-analysis";
import type { DataTable } from "@/lib/tabular";

use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const props = defineProps<{ table: DataTable }>();

const { t } = useI18n();
const theme = useTheme();

const CHART_TYPES: ChartType[] = ["bar", "line", "pie"];
const AGGREGATIONS: Aggregation[] = ["sum", "count", "avg", "min", "max", "distinct"];

const columns = computed(() => props.table.columns);

const chartType = ref<ChartType>("bar");
const categoryColumn = ref(0);
const valueColumn = ref(0);
const aggregation = ref<Aggregation>("sum");

/** 与当前列集对齐：换工作表 / 换文件后旧下标可能越界，直接算会得到 undefined 列。 */
watch(
  columns,
  (next) => {
    const numeric = next.filter((column) => column.type === "number");
    if (!next.some((column) => column.index === categoryColumn.value)) categoryColumn.value = next[0]?.index ?? 0;
    // 值列必须落在**数值列**上：默认下标 0 往往是文本列，拿它求和只会画出一排 0。
    if (!numeric.some((column) => column.index === valueColumn.value)) valueColumn.value = numeric[0]?.index ?? 0;
    if (aggregation.value === "sum" && numeric.length === 0) aggregation.value = "count";
  },
  { immediate: true },
);

const config = computed<ChartConfig>(() => ({
  type: chartType.value,
  categoryColumn: categoryColumn.value,
  valueColumn: valueColumn.value,
  aggregation: aggregation.value,
}));

const series = computed(() => buildChartSeries(props.table, config.value));

/** 读当前主题的取色真源（CSS 变量）；读不到就回落到暗色默认值，图表不该因为取不到色而不画。 */
function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

function readPalette(): ChartPalette {
  return {
    series: [
      cssVar("--cyan", "#4d9fff"),
      cssVar("--mint", "#23c343"),
      cssVar("--amber", "#ff9a2e"),
      cssVar("--violet", "#8b5cf6"),
      cssVar("--orange", "#f76560"),
    ],
    text: cssVar("--dim", "#ced3da"),
    axis: cssVar("--line-2", "#2e2e2e"),
    split: cssVar("--line", "#1f1f1f"),
    tooltipBackground: cssVar("--panel-2", "#141414"),
    tooltipBorder: cssVar("--line-2", "#2e2e2e"),
  };
}

const container = ref<HTMLElement | null>(null);
/** 渲染失败（如环境没有 canvas）时不把异常抛穿，改成一句人话 —— 面板其余部分仍然可用。 */
const failed = ref(false);
let chart: ReturnType<typeof init> | null = null;

function render(): void {
  const element = container.value;
  if (!element || series.value.data.length === 0) return;
  try {
    chart ??= init(element);
    // notMerge：切换图表类型时旧系列的配置项必须整体丢掉，否则会残留上一种图的轴 / 图例。
    chart.setOption(buildChartOption(series.value, config.value, readPalette()), true);
    failed.value = false;
  } catch {
    failed.value = true;
  }
}

let observer: ResizeObserver | null = null;

onMounted(() => {
  render();
  // happy-dom 等测试环境没有 ResizeObserver；没有它图表只是不自适应，不该报错。
  if (typeof ResizeObserver !== "undefined" && container.value) {
    observer = new ResizeObserver(() => chart?.resize());
    observer.observe(container.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  chart?.dispose();
  chart = null;
});

// post：等 DOM 与容器尺寸落定后再画，否则首次渲染拿到的是 0×0。
watch([series, config, theme], () => render(), { flush: "post" });
</script>

<template>
  <div data-testid="analysis-chart" class="flex flex-col gap-2 p-3">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <label class="flex items-center gap-1 text-[11px] text-dim2">
        {{ t("preview.analysis.chart.type") }}
        <select
          v-model="chartType"
          data-testid="chart-type"
          class="h-5 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
        >
          <option v-for="option in CHART_TYPES" :key="option" :value="option">{{ t(`preview.analysis.chart.${option}`) }}</option>
        </select>
      </label>

      <label class="flex items-center gap-1 text-[11px] text-dim2">
        {{ t("preview.analysis.chart.category") }}
        <select
          v-model.number="categoryColumn"
          data-testid="chart-category-column"
          class="h-5 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
        >
          <option v-for="column in columns" :key="column.index" :value="column.index">{{ column.name }}</option>
        </select>
      </label>

      <label class="flex items-center gap-1 text-[11px] text-dim2">
        {{ t("preview.analysis.chart.value") }}
        <select
          v-model.number="valueColumn"
          data-testid="chart-value-column"
          class="h-5 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
        >
          <option v-for="column in columns" :key="column.index" :value="column.index">{{ column.name }}</option>
        </select>
      </label>

      <label class="flex items-center gap-1 text-[11px] text-dim2">
        {{ t("preview.analysis.chart.aggregate") }}
        <select
          v-model="aggregation"
          data-testid="chart-aggregation"
          class="h-5 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
        >
          <option v-for="option in AGGREGATIONS" :key="option" :value="option">{{ t(`preview.analysis.agg.${option}`) }}</option>
        </select>
      </label>
    </div>

    <p v-if="columns.length === 0 || series.data.length === 0" class="text-[12px] text-dim2">{{ t("preview.analysis.chart.empty") }}</p>
    <p v-else-if="failed" role="alert" class="text-[12px] text-orange">{{ t("preview.analysis.chart.unavailable") }}</p>

    <div v-show="!failed && series.data.length > 0" ref="container" data-testid="chart-canvas" class="h-[200px] w-full" />

    <p v-if="series.truncated" class="text-[11px] text-dim2">
      {{ t("preview.analysis.chart.truncated", { n: series.data.length, total: series.total }) }}
    </p>
  </div>
</template>
