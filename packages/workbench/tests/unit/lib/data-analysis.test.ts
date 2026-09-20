/**
 * 分析计算：统计、筛选、排序、分组。
 *
 * 这些函数产出的数字就是用户看到的结论，口径错一位（比如中位数在偶数长度下取错、
 * 空值在降序里跑到最前）都会让用户拿着错数据做判断 —— 逐条钉住。
 */
import { describe, expect, it } from "vitest";
import { applyFilters, computeColumnStats, groupBy, MAX_GROUPS, sortRows, type FilterCondition } from "@/lib/data-analysis";
import { toDataTable, type DataTable } from "@/lib/tabular";

function table(rows: string[][]): DataTable {
  return toDataTable({ sheets: [], name: "", rows, truncated: false });
}

/** 站点 / 客流 / 日期 —— 覆盖数值列、文本列、日期列三种形态。 */
const SAMPLE = table([
  ["station", "riders", "date"],
  ["A", "10", "2024-01-02"],
  ["B", "20", "2024-01-03"],
  ["A", "30", "2024-01-04"],
  ["C", "", "2024-01-05"],
]);

describe("computeColumnStats", () => {
  it("数值列给出计数、空值、唯一值与六项摘要", () => {
    const stats = computeColumnStats(SAMPLE);
    const riders = stats[1];
    expect(riders.name).toBe("riders");
    expect(riders.type).toBe("number");
    expect(riders.count).toBe(3);
    expect(riders.empty).toBe(1);
    expect(riders.distinct).toBe(3);
    expect(riders.min).toBe(10);
    expect(riders.max).toBe(30);
    expect(riders.sum).toBe(60);
    expect(riders.mean).toBe(20);
    expect(riders.median).toBe(20);
  });

  it("文本列不做数值摘要，六项全 null（0 与「没有数据」必须区分得开）", () => {
    const station = computeColumnStats(SAMPLE)[0];
    expect(station.type).toBe("text");
    expect(station.count).toBe(4);
    expect(station.distinct).toBe(3);
    expect(station.sum).toBeNull();
    expect(station.mean).toBeNull();
    expect(station.median).toBeNull();
  });

  it("总体标准差（除以 N，不是 N-1）", () => {
    // 10/20/30 的总体标准差 = sqrt(200/3) ≈ 8.1649…
    const riders = computeColumnStats(SAMPLE)[1];
    expect(riders.stdDev).toBeCloseTo(Math.sqrt(200 / 3), 10);
  });

  it("偶数个数值的中位数取中间两个的均值", () => {
    const even = computeColumnStats(table([["v"], ["1"], ["2"], ["3"], ["4"]]))[0];
    expect(even.median).toBe(2.5);
  });

  it("全是空值的数值列：数值摘要全 null，不返回 0", () => {
    const empty = computeColumnStats(table([["v"], [""], [""]]))[0];
    expect(empty.type).toBe("empty");
    expect(empty.count).toBe(0);
    expect(empty.empty).toBe(2);
    expect(empty.sum).toBeNull();
  });

  it("大列不吃 Math.min(...) 的实参上限", () => {
    const rows = [["v"], ...Array.from({ length: 30000 }, (_, index) => [String(index)])];
    const stats = computeColumnStats(table(rows))[0];
    expect(stats.count).toBe(30000);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(29999);
  });
});

describe("applyFilters", () => {
  const riders = (op: FilterCondition["op"], value: string): FilterCondition => ({ column: 1, op, value });

  it("无有效条件时原样返回（不复制、不筛空）", () => {
    const rows = SAMPLE.rows;
    expect(applyFilters(rows, [])).toBe(rows);
    // 值为空的条件被跳过：刚点「添加条件」还没填值时整张表不该突然空掉
    expect(applyFilters(rows, [riders("contains", "")])).toBe(rows);
  });

  it("文本算子：contains / notContains / equals（忽略大小写）", () => {
    expect(applyFilters(SAMPLE.rows, [{ column: 0, op: "contains", value: "a" }])).toHaveLength(2);
    expect(applyFilters(SAMPLE.rows, [{ column: 0, op: "notContains", value: "A" }])).toHaveLength(2);
    expect(applyFilters(SAMPLE.rows, [{ column: 0, op: "equals", value: "b" }])).toHaveLength(1);
    expect(applyFilters(SAMPLE.rows, [{ column: 0, op: "notEquals", value: "A" }])).toHaveLength(2);
  });

  it("相等比较对数字按数值比、对文本按忽略大小写比", () => {
    expect(applyFilters(SAMPLE.rows, [riders("equals", "10")])).toHaveLength(1);
    // "10" 与 "10.0" 数值相等
    expect(applyFilters(SAMPLE.rows, [riders("equals", "10.0")])).toHaveLength(1);
  });

  it("大小比较只对能读成数字的格子成立，读不出来的判否（不当 0）", () => {
    expect(applyFilters(SAMPLE.rows, [riders("gt", "15")])).toHaveLength(2);
    expect(applyFilters(SAMPLE.rows, [riders("gte", "20")])).toHaveLength(2);
    expect(applyFilters(SAMPLE.rows, [riders("lt", "20")])).toHaveLength(1);
    expect(applyFilters(SAMPLE.rows, [riders("lte", "20")])).toHaveLength(2);
    // 空单元格不满足任何大小比较
    expect(applyFilters(SAMPLE.rows, [riders("lt", "999")])).toHaveLength(3);
  });

  it("empty / notEmpty 不需要值", () => {
    expect(applyFilters(SAMPLE.rows, [riders("empty", "")])).toHaveLength(1);
    expect(applyFilters(SAMPLE.rows, [riders("notEmpty", "")])).toHaveLength(3);
  });

  it("多个条件之间是「且」", () => {
    const conditions: FilterCondition[] = [
      { column: 0, op: "equals", value: "A" },
      { column: 1, op: "gte", value: "20" },
    ];
    expect(applyFilters(SAMPLE.rows, conditions)).toEqual([["A", "30", "2024-01-04"]]);
  });
});

describe("sortRows", () => {
  it("无排序规格时原样返回", () => {
    const rows = SAMPLE.rows;
    expect(sortRows(rows, null, SAMPLE.columns)).toBe(rows);
  });

  it("数值列按数值排，不按字典序", () => {
    const sorted = sortRows(SAMPLE.rows, { column: 1, direction: "asc" }, SAMPLE.columns);
    // 空值恒排最后，所以 10/20/30 之后才是空
    expect(sorted.map((row) => row[1])).toEqual(["10", "20", "30", ""]);
  });

  it("空值恒排最后，且不随升降序翻转", () => {
    const asc = sortRows(SAMPLE.rows, { column: 1, direction: "asc" }, SAMPLE.columns);
    const desc = sortRows(SAMPLE.rows, { column: 1, direction: "desc" }, SAMPLE.columns);
    expect(asc[asc.length - 1][1]).toBe("");
    expect(desc[desc.length - 1][1]).toBe("");
    expect(desc.map((row) => row[1])).toEqual(["30", "20", "10", ""]);
  });

  it("日期列按时间排，不按字典序", () => {
    const sheet = table([["d"], ["2024-6-30"], ["2024-01-02"], ["2025-12-31"]]);
    const sorted = sortRows(sheet.rows, { column: 0, direction: "asc" }, sheet.columns);
    expect(sorted.map((row) => row[0])).toEqual(["2024-01-02", "2024-6-30", "2025-12-31"]);
  });

  it("文本列按本地化自然序（数字段按数值比）", () => {
    const sheet = table([["v"], ["第10章"], ["第2章"], ["第1章"]]);
    const sorted = sortRows(sheet.rows, { column: 0, direction: "asc" }, sheet.columns);
    expect(sorted.map((row) => row[0])).toEqual(["第1章", "第2章", "第10章"]);
  });

  it("返回新数组，调用方手里的原顺序不受影响", () => {
    const before = SAMPLE.rows.map((row) => row[1]);
    sortRows(SAMPLE.rows, { column: 1, direction: "desc" }, SAMPLE.columns);
    expect(SAMPLE.rows.map((row) => row[1])).toEqual(before);
  });
});

describe("groupBy", () => {
  const spec = (aggregation: Parameters<typeof groupBy>[1]["aggregation"]) => ({ keyColumn: 0, valueColumn: 1, aggregation }) as const;

  it("按分组键聚合，结果按聚合值降序", () => {
    const result = groupBy(SAMPLE.rows, spec("sum"));
    expect(result.total).toBe(3);
    expect(result.groups).toEqual([
      { key: "A", value: 40, count: 2 },
      { key: "B", value: 20, count: 1 },
      // C 没有数值，sum 为 null，排最后
      { key: "C", value: null, count: 1 },
    ]);
  });

  it("count 是行数，distinct 是去重值数（空值不计入 distinct）", () => {
    expect(groupBy(SAMPLE.rows, spec("count")).groups.find((group) => group.key === "C")).toEqual({ key: "C", value: 1, count: 1 });
    const distinct = groupBy(SAMPLE.rows, spec("distinct")).groups.find((group) => group.key === "C");
    expect(distinct?.value).toBe(0);
  });

  it("avg / min / max", () => {
    const avg = groupBy(SAMPLE.rows, spec("avg")).groups.find((group) => group.key === "A");
    expect(avg?.value).toBe(20);
    expect(groupBy(SAMPLE.rows, spec("min")).groups.find((group) => group.key === "A")?.value).toBe(10);
    expect(groupBy(SAMPLE.rows, spec("max")).groups.find((group) => group.key === "A")?.value).toBe(30);
  });

  it("空键原样保留（文案由界面决定，纯逻辑不掺 i18n）", () => {
    const sheet = table([["k"], [""], ["x"]]);
    const result = groupBy(sheet.rows, spec("count"));
    expect(result.groups[0].key).toBe("");
  });

  it("超过上限时截断并标记", () => {
    const sheet = table([["k", "v"], ...Array.from({ length: MAX_GROUPS + 5 }, (_, index) => [`k${index}`, "1"])]);
    const result = groupBy(sheet.rows, spec("sum"));
    expect(result.total).toBe(MAX_GROUPS + 5);
    expect(result.truncated).toBe(true);
    expect(result.groups).toHaveLength(MAX_GROUPS);
  });

  it("单个分组上万行不吃 Math.min/max 的实参上限", () => {
    const sheet = table([["k", "v"], ...Array.from({ length: 30000 }, () => ["same", "1"])]);
    const result = groupBy(sheet.rows, spec("sum"));
    expect(result.groups).toEqual([{ key: "same", value: 30000, count: 30000 }]);
  });
});
