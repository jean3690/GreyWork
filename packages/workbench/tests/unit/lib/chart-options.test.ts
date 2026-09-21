/**
 * 图表配置：`buildChartSeries` 是图表与「分组」页签共用的口径，算错就等于两处一起错。
 * ECharts 配置本身只做形状断言 —— 颜色与排版细节由组件测试覆盖。
 */
import { describe, expect, it } from "vitest";
import { buildChartOption, buildChartSeries, MAX_CHART_CATEGORIES, type ChartConfig, type ChartPalette } from "@/lib/chart-options";
import { toDataTable, type DataTable } from "@/lib/tabular";

function table(rows: string[][]): DataTable {
  return toDataTable({ sheets: [], name: "", rows, truncated: false });
}

const PALETTE: ChartPalette = {
  series: ["#111", "#222"],
  text: "#fff",
  axis: "#333",
  split: "#444",
  tooltipBackground: "#000",
  tooltipBorder: "#555",
};

const SAMPLE = table([
  ["station", "riders"],
  ["A", "10"],
  ["B", "20"],
  ["A", "30"],
  ["C", ""],
]);

const config = (overrides: Partial<ChartConfig> = {}): ChartConfig => ({
  type: "bar",
  categoryColumn: 0,
  valueColumn: 1,
  aggregation: "sum",
  ...overrides,
});

describe("buildChartSeries", () => {
  it("按分类列聚合，降序排列", () => {
    const series = buildChartSeries(SAMPLE, config());
    expect(series.data).toEqual([
      { label: "A", value: 40 },
      { label: "B", value: 20 },
      { label: "C", value: 0 },
    ]);
    expect(series.total).toBe(3);
    expect(series.truncated).toBe(false);
  });

  it("聚合方式透传到分组（count 得到行数）", () => {
    const series = buildChartSeries(SAMPLE, config({ aggregation: "count" }));
    expect(series.data).toEqual([
      { label: "A", value: 2 },
      { label: "B", value: 1 },
      { label: "C", value: 1 },
    ]);
  });

  it("没有可用数值的组按 0 画，不产生 NaN", () => {
    const series = buildChartSeries(SAMPLE, config());
    expect(series.data.every((datum) => Number.isFinite(datum.value))).toBe(true);
  });

  it("超过上限只保留最大的前 N 项并标记截断", () => {
    const rows = [["k", "v"], ...Array.from({ length: MAX_CHART_CATEGORIES + 10 }, (_, index) => [`k${index}`, String(index)])];
    const series = buildChartSeries(table(rows), config());
    expect(series.data).toHaveLength(MAX_CHART_CATEGORIES);
    expect(series.total).toBe(MAX_CHART_CATEGORIES + 10);
    expect(series.truncated).toBe(true);
    // 截掉的是最小的那些：最大的 k{N+9} 必须在
    expect(series.data[0].label).toBe(`k${MAX_CHART_CATEGORIES + 9}`);
  });

  it("空表返回空数据而不是抛错", () => {
    const series = buildChartSeries(table([]), config());
    expect(series).toEqual({ data: [], truncated: false, total: 0 });
  });
});

describe("buildChartOption", () => {
  it("柱状图：分类轴取标签、系列取数值", () => {
    const option = buildChartOption(buildChartSeries(SAMPLE, config()), config(), PALETTE);
    const series = (option.series as { type: string; data: number[] }[])[0];
    expect(series.type).toBe("bar");
    expect(series.data).toEqual([40, 20, 0]);
    expect((option.xAxis as { data: string[] }).data).toEqual(["A", "B", "C"]);
  });

  it("折线图用 line 系列", () => {
    const lineConfig = config({ type: "line" });
    const option = buildChartOption(buildChartSeries(SAMPLE, lineConfig), lineConfig, PALETTE);
    expect((option.series as { type: string }[])[0].type).toBe("line");
  });

  it("饼图：数据项是 {name,value}，且不生成坐标轴", () => {
    const pieConfig = config({ type: "pie" });
    const option = buildChartOption(buildChartSeries(SAMPLE, pieConfig), pieConfig, PALETTE);
    expect(option.xAxis).toBeUndefined();
    expect((option.series as { type: string; data: { name: string; value: number }[] }[])[0].data).toEqual([
      { name: "A", value: 40 },
      { name: "B", value: 20 },
      { name: "C", value: 0 },
    ]);
  });

  it("分类多时标签旋转 30°，少时不旋转", () => {
    const many = table([["k", "v"], ...Array.from({ length: 8 }, (_, index) => [`k${index}`, "1"])]);
    expect(
      (buildChartOption(buildChartSeries(many, config()), config(), PALETTE).xAxis as { axisLabel: { rotate: number } }).axisLabel.rotate,
    ).toBe(30);
    expect(
      (buildChartOption(buildChartSeries(SAMPLE, config()), config(), PALETTE).xAxis as { axisLabel: { rotate: number } }).axisLabel.rotate,
    ).toBe(0);
  });

  it("配色来自传入的 palette，不用 ECharts 自带主题", () => {
    const option = buildChartOption(buildChartSeries(SAMPLE, config()), config(), PALETTE);
    expect(option.color).toEqual(PALETTE.series);
  });
});
