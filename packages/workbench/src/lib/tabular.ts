/**
 * 表格数据的统一模型。
 *
 * 三条来源（CSV 文本、exceljs 读 xlsx、宿主 calamine 读 xls）都在这里收口成同一种形状，
 * 分析面板因此完全不必知道数据是从哪来的 —— 否则「筛选/统计/图表」要对每种来源各写一遍。
 *
 * 纯逻辑、零依赖：类型推断与数字解析是分析结果正确性的地基，必须能脱离组件单测。
 */

/** 一张工作表的归一化载荷；`rows` 含首行（首行是否表头由 `toDataTable` 决定）。 */
export interface SheetTable {
  /** 工作簿里全部工作表名；CSV 没有工作表概念，为空数组。 */
  sheets: string[];
  /** 本次解析的是哪一张；CSV 为空串。 */
  name: string;
  rows: string[][];
  /** 来源侧因上限被截断（xls 的行/列上限、xlsx 的行上限）。 */
  truncated: boolean;
}

export type ColumnType = "number" | "date" | "text" | "empty";

export interface DataColumn {
  index: number;
  /** 表头文本；空表头回落为「列 N」，免得表格里出现一排无名列。 */
  name: string;
  type: ColumnType;
}

export interface DataTable {
  columns: DataColumn[];
  /** 数据行（不含表头）。 */
  rows: string[][];
  sheets: string[];
  sheetName: string;
  truncated: boolean;
}

/**
 * 展示字符串 → 数字；不是数字返回 null。
 *
 * 千分位逗号与尾随百分号都要剥掉：它们是导出的 CSV 里最常见的两种「看着像数字但
 * `Number()` 读不出来」的形态。
 *
 * **百分号只当单位标记剥掉、不除以 100** —— 一列 `12%` / `45%` 的用户期望均值是 28.5，
 * 而不是 0.285；真要表达比例的数据本来就会写成 `0.12`。两种写法混在一列属于脏数据，
 * 不在本函数的兜底范围内。
 */
export function toNumber(value: string): number | null {
  const normalized = value.trim().replace(/,/g, "").replace(/%$/, "");
  if (normalized === "") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `YYYY-MM-DD` / `YYYY/MM/DD`（可选 `HH:MM[:SS]`）→ 时间戳；其余返回 null。
 *
 * 刻意不用 `Date.parse`：它对 `01/02/2024` 这类写法按美式月/日解释，还会把
 * `"1/2"`、`"2024"` 之类当日期，结果是一列备注被当成日期列。宁可漏认，
 * 也不要认错 —— 认错会让排序与统计悄悄给出错误答案。
 */
const DATE_PATTERN = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export function toTimestamp(value: string): number | null {
  const match = DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0));
  const date = new Date(stamp);
  // 日期回读校验：Date.UTC 会把 2024-02-31 悄悄滚成 2024-03-02，滚过的不是合法日期。
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) {
    return null;
  }
  return stamp;
}

/**
 * 推断一列的类型。
 *
 * 用「过半」而不是「全部」：真实表格里数值列常混着 `N/A`、`-`、备注，要求全列都是数字
 * 会把它们统统降级成文本，用户就再也拿不到求和与均值 —— 而这恰恰是最常用的两项。
 * 空单元格不参与投票（它们不是「非数字」的证据）。
 */
export function inferColumnType(values: readonly string[]): ColumnType {
  let filled = 0;
  let numeric = 0;
  let dates = 0;
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "") continue;
    filled += 1;
    if (toNumber(trimmed) !== null) {
      numeric += 1;
      continue;
    }
    if (toTimestamp(trimmed) !== null) dates += 1;
  }
  if (filled === 0) return "empty";
  if (numeric * 2 > filled) return "number";
  if (dates * 2 > filled) return "date";
  return "text";
}

/** 归一化载荷 → 分析用数据表：首行当表头，与 CSV / xlsx 预览的既有口径一致。 */
export function toDataTable(sheet: SheetTable): DataTable {
  const [header = [], ...body] = sheet.rows;
  const columns: DataColumn[] = header.map((name, index) => {
    const trimmed = name.trim();
    return {
      index,
      name: trimmed === "" ? `列 ${index + 1}` : trimmed,
      type: inferColumnType(body.map((row) => row[index] ?? "")),
    };
  });
  return { columns, rows: body, sheets: sheet.sheets, sheetName: sheet.name, truncated: sheet.truncated };
}
