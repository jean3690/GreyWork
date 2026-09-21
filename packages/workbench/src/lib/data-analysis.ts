/**
 * 数据分析的纯计算：列统计、筛选、排序、分组聚合。
 *
 * 全部是无状态纯函数，不碰 Vue、不碰 DOM —— 这些函数给出的数字就是用户看到的结论，
 * 必须能被单测逐条钉住；把口径写在组件里等于让「均值算错」这类问题只能靠肉眼发现。
 *
 * **统计口径**：一切计算都基于调用方传进来的行集合。分析面板传的是「全部已解析行经筛选后」
 * 的集合，而网格渲染另有 500 行上限 —— 两者刻意分开：看得少不等于算得少。
 */

import { toNumber, toTimestamp, type ColumnType, type DataColumn, type DataTable } from "./tabular";

export interface ColumnStats {
  index: number;
  name: string;
  type: ColumnType;
  /** 非空单元格数。 */
  count: number;
  /** 空单元格数。 */
  empty: number;
  /** 去重后的非空值个数。 */
  distinct: number;
  /** 以下六项仅数值列有值，其余列为 null（显示成「—」而不是 0）。 */
  min: number | null;
  max: number | null;
  sum: number | null;
  mean: number | null;
  median: number | null;
  stdDev: number | null;
}

/** 数值列的六项摘要。空数组返回全 null —— 0 与「没有数据」必须区分得开。 */
function numericSummary(values: readonly number[]): Pick<ColumnStats, "min" | "max" | "sum" | "mean" | "median" | "stdDev"> {
  if (values.length === 0) return { min: null, max: null, sum: null, mean: null, median: null, stdDev: null };

  // 不用 Math.min(...values)：展开成实参在几万行时会顶到引擎的实参个数上限而抛栈溢出。
  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  const mean = sum / values.length;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;

  let squared = 0;
  for (const value of values) squared += (value - mean) ** 2;
  // 总体标准差（除以 N）而非样本标准差（除以 N-1）：这里拿到的是全量数据，不是抽样。
  const stdDev = Math.sqrt(squared / values.length);

  return { min, max, sum, mean, median, stdDev };
}

/** 逐列统计。非数值列只给计数/空值/唯一值，不硬凑求和。 */
export function computeColumnStats(table: DataTable): ColumnStats[] {
  return table.columns.map((column) => {
    const numbers: number[] = [];
    const distinct = new Set<string>();
    let empty = 0;
    for (const row of table.rows) {
      const trimmed = (row[column.index] ?? "").trim();
      if (trimmed === "") {
        empty += 1;
        continue;
      }
      distinct.add(trimmed);
      const parsed = toNumber(trimmed);
      if (parsed !== null) numbers.push(parsed);
    }
    const numeric = column.type === "number" ? numericSummary(numbers) : numericSummary([]);
    return {
      index: column.index,
      name: column.name,
      type: column.type,
      count: table.rows.length - empty,
      empty,
      distinct: distinct.size,
      ...numeric,
    };
  });
}

/* ── 筛选 ──────────────────────────────────────────────────────────────── */

export type FilterOp = "contains" | "notContains" | "equals" | "notEquals" | "gt" | "gte" | "lt" | "lte" | "empty" | "notEmpty";

export interface FilterCondition {
  column: number;
  op: FilterOp;
  value: string;
}

/** 相等比较：两边都能读成数字就按数值比，否则按文本（忽略大小写）比。 */
function equalsLoose(cell: string, target: string): boolean {
  const left = toNumber(cell);
  const right = toNumber(target);
  if (left !== null && right !== null) return left === right;
  return cell.toLowerCase() === target.toLowerCase();
}

function matchesCondition(cell: string, condition: FilterCondition): boolean {
  const trimmed = cell.trim();
  const target = condition.value.trim();
  switch (condition.op) {
    case "empty":
      return trimmed === "";
    case "notEmpty":
      return trimmed !== "";
    case "contains":
      return trimmed.toLowerCase().includes(target.toLowerCase());
    case "notContains":
      return !trimmed.toLowerCase().includes(target.toLowerCase());
    case "equals":
      return equalsLoose(trimmed, target);
    case "notEquals":
      return !equalsLoose(trimmed, target);
    default: {
      // 大小比较只对能读成数字的单元格成立；读不出来的行直接判否（而不是当 0）。
      const left = toNumber(trimmed);
      const right = toNumber(target);
      if (left === null || right === null) return false;
      if (condition.op === "gt") return left > right;
      if (condition.op === "gte") return left >= right;
      if (condition.op === "lt") return left < right;
      return left <= right;
    }
  }
}

/**
 * 按条件逐行过滤（多个条件之间是「且」）。
 *
 * 值为空的条件会被跳过（`empty` / `notEmpty` 两种算子除外，它们本来就不需要值）：
 * 用户刚点了「添加条件」还没填值时，整张表不该突然空掉。
 */
export function applyFilters(rows: string[][], conditions: readonly FilterCondition[]): string[][] {
  const active = conditions.filter((condition) => condition.op === "empty" || condition.op === "notEmpty" || condition.value.trim() !== "");
  if (active.length === 0) return rows;
  return rows.filter((row) => active.every((condition) => matchesCondition(row[condition.column] ?? "", condition)));
}

/* ── 排序 ──────────────────────────────────────────────────────────────── */

export interface SortSpec {
  column: number;
  direction: "asc" | "desc";
}

function compareValues(left: string, right: string, type: ColumnType): number {
  if (type === "number") {
    const a = toNumber(left);
    const b = toNumber(right);
    if (a !== null && b !== null) return a - b;
  }
  if (type === "date") {
    const a = toTimestamp(left);
    const b = toTimestamp(right);
    if (a !== null && b !== null) return a - b;
  }
  // `numeric` 让 "第2章" 排在 "第10章" 前面 —— 纯字典序会把它排反。
  return left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" });
}

/**
 * 按某一列排序，返回**新数组**（调用方往往还持有未排序的行）。
 *
 * 空值恒排最后，且**不随升降序翻转** —— 与多数表格软件一致：缺数据不该因为切了降序
 * 就跑到最前面来占位置。
 */
export function sortRows(rows: string[][], sort: SortSpec | null, columns: readonly DataColumn[]): string[][] {
  if (!sort) return rows;
  const type = columns[sort.column]?.type ?? "text";
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = (a[sort.column] ?? "").trim();
    const right = (b[sort.column] ?? "").trim();
    if (left === "" || right === "") {
      if (left === right) return 0;
      return left === "" ? 1 : -1;
    }
    return factor * compareValues(left, right, type);
  });
}

/* ── 分组聚合 ──────────────────────────────────────────────────────────── */

export type Aggregation = "count" | "sum" | "avg" | "min" | "max" | "distinct";

export interface GroupBySpec {
  keyColumn: number;
  valueColumn: number;
  aggregation: Aggregation;
}

export interface GroupResult {
  /** 分组键原文（空键为空串，显示成什么由界面决定，这里不掺文案）。 */
  key: string;
  /** 聚合结果；该组没有可用数值时为 null。 */
  value: number | null;
  /** 该组的原始行数。 */
  count: number;
}

export interface GroupByResult {
  groups: GroupResult[];
  /** 分组总数（截断前）。 */
  total: number;
  truncated: boolean;
}

/** 分组结果上限：几百行的结果表在 320px 宽的预览栏里已经没法看，也画不进图。 */
export const MAX_GROUPS = 200;

/**
 * 分析数值的展示：最多 4 位小数并带千分位，null 显示成「—」。
 *
 * 均值与标准差是除出来的数，直接 String() 会得到 `8.16496580927726` 这种噪音；
 * 而 null 必须与 0 区分得开 —— 前者是「这列没有可用数值」，后者是「算出来就是 0」。
 * 固定用 en-US：zh-CN 与 en-US 的分组/小数点符号一致，不必为此把 locale 一路传下来。
 */
const METRIC_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

export function formatMetric(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return METRIC_FORMAT.format(value);
}

interface Bucket {
  numbers: number[];
  distinct: Set<string>;
  count: number;
}

function aggregate(bucket: Bucket, aggregation: Aggregation): number | null {
  if (aggregation === "count") return bucket.count;
  if (aggregation === "distinct") return bucket.distinct.size;
  if (bucket.numbers.length === 0) return null;

  // 同样不用 Math.min(...values)：单个分组也可能有上万行，展开成实参同样会顶到上限。
  let sum = 0;
  let min = bucket.numbers[0];
  let max = bucket.numbers[0];
  for (const value of bucket.numbers) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  if (aggregation === "sum") return sum;
  if (aggregation === "avg") return sum / bucket.numbers.length;
  return aggregation === "min" ? min : max;
}

/**
 * 按某列分组，对另一列做聚合，结果按聚合值降序（null 排最后）。
 *
 * 图表也走这里：柱/折线/饼本质就是「分组 + 聚合」的两种画法，共用一份口径可以保证
 * 「图上看到的数」与「分组表里的数」永远一致。
 */
export function groupBy(rows: readonly string[][], spec: GroupBySpec): GroupByResult {
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const key = (row[spec.keyColumn] ?? "").trim();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { numbers: [], distinct: new Set(), count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const cell = (row[spec.valueColumn] ?? "").trim();
    if (cell !== "") bucket.distinct.add(cell);
    const parsed = toNumber(cell);
    if (parsed !== null) bucket.numbers.push(parsed);
  }

  const groups: GroupResult[] = [...buckets].map(([key, bucket]) => ({
    key,
    value: aggregate(bucket, spec.aggregation),
    count: bucket.count,
  }));
  groups.sort((a, b) => {
    if (a.value === null || b.value === null) {
      if (a.value === b.value) return a.count - b.count;
      return a.value === null ? 1 : -1;
    }
    return b.value - a.value;
  });

  return { groups: groups.slice(0, MAX_GROUPS), total: groups.length, truncated: groups.length > MAX_GROUPS };
}
