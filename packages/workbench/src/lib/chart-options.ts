/**
 * 图表数据与 ECharts 配置的纯逻辑。
 *
 * 拆成两层是为了可测：
 * - `buildChartSeries` 只做「分组聚合 + Top-N」，与「分组」页签共用同一份口径，
 *   所以图上看到的数永远等于分组表里的数；
 * - `buildChartOption` 只做「数据 → ECharts 配置」的映射，不含任何计算。
 *
 * 这里不引 echarts 的运行时（只用 `import type`，编译后被完全擦除）：纯逻辑单测因此
 * 不必拉起整个图表库，也让这个文件永远落不进任何 chunk。
 */

import type { EChartsOption } from "echarts";
import { groupBy, type Aggregation } from "./data-analysis";
import type { DataTable } from "./tabular";

export type ChartType = "bar" | "line" | "pie";

export interface ChartConfig {
  type: ChartType;
  categoryColumn: number;
  valueColumn: number;
  aggregation: Aggregation;
}

/** 图表配色。由组件从 CSS 变量读出来注入，纯逻辑层不认识主题系统。 */
export interface ChartPalette {
  series: string[];
  text: string;
  axis: string;
  split: string;
  tooltipBackground: string;
  tooltipBorder: string;
}

export interface ChartDatum {
  label: string;
  value: number;
}

export interface ChartSeries {
  data: ChartDatum[];
  /** 因 `MAX_CHART_CATEGORIES` 被截断（截掉的是聚合值最小的那些）。 */
  truncated: boolean;
  /** 截断前的分组总数。 */
  total: number;
}

/**
 * 图上最多画多少项。
 *
 * 饼图尤其吃这个上限：几百个扇区既读不出也画不下，而预览栏最窄只有 320px。
 * 分组结果已按聚合值降序，所以截断丢掉的都是最小的那些，不影响主结论。
 */
export const MAX_CHART_CATEGORIES = 20;

/** 分组聚合 → 图表数据点。 */
export function buildChartSeries(table: DataTable, config: ChartConfig): ChartSeries {
  const grouped = groupBy(table.rows, {
    keyColumn: config.categoryColumn,
    valueColumn: config.valueColumn,
    aggregation: config.aggregation,
  });
  const data = grouped.groups.slice(0, MAX_CHART_CATEGORIES).map((group) => ({ label: group.key, value: group.value ?? 0 }));
  return { data, truncated: grouped.total > MAX_CHART_CATEGORIES, total: grouped.total };
}

function tooltipStyle(palette: ChartPalette): EChartsOption["tooltip"] {
  return {
    backgroundColor: palette.tooltipBackground,
    borderColor: palette.tooltipBorder,
    textStyle: { color: palette.text, fontSize: 11 },
  };
}

/**
 * 图表数据 → ECharts 配置。
 *
 * 颜色一律来自 palette（即宿主主题的 CSS 变量），不用 ECharts 自带主题 ——
 * 自带主题只分亮/暗两套，切到本仓的其它调色板就会与界面脱节。
 */
export function buildChartOption(series: ChartSeries, config: ChartConfig, palette: ChartPalette): EChartsOption {
  const labels = series.data.map((datum) => datum.label);
  const values = series.data.map((datum) => datum.value);

  if (config.type === "pie") {
    return {
      color: palette.series,
      tooltip: { trigger: "item", ...tooltipStyle(palette) },
      legend: { type: "scroll", bottom: 0, itemWidth: 8, itemHeight: 8, textStyle: { color: palette.text, fontSize: 10 } },
      series: [
        {
          type: "pie",
          radius: ["36%", "62%"],
          // 给图例留出底部空间，否则饼会被压到图例上。
          center: ["50%", "42%"],
          data: series.data.map((datum) => ({ name: datum.label, value: datum.value })),
          label: { color: palette.text, fontSize: 10 },
          labelLine: { lineStyle: { color: palette.axis } },
        },
      ],
    };
  }

  // 显式标注 EChartsOption：否则对象字面量里的 `trigger: "axis"` 会被推宽成 string，
  // 与 ECharts 的联合类型对不上。
  const cartesian: EChartsOption = {
    color: palette.series,
    grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
    tooltip: { ...tooltipStyle(palette), trigger: "axis" },
    xAxis: {
      type: "category",
      data: labels,
      // 分类多时旋转 30°，否则 320px 宽下标签会糊成一片。
      axisLabel: { color: palette.text, fontSize: 10, interval: 0, rotate: labels.length > 6 ? 30 : 0 },
      axisLine: { lineStyle: { color: palette.axis } },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.text, fontSize: 10 },
      splitLine: { lineStyle: { color: palette.split } },
    },
  };

  return config.type === "bar"
    ? { ...cartesian, series: [{ type: "bar", data: values, barMaxWidth: 24 }] }
    : { ...cartesian, series: [{ type: "line", data: values }] };
}
