/**
 * 表格模型：数字解析与列类型推断是分析结论的地基 —— 判错类型会让「求和/均值」整列消失，
 * 认错日期会让排序悄悄给出错误顺序，两条都必须逐边界钉住。
 */
import { describe, expect, it } from "vitest";
import { inferColumnType, toDataTable, toNumber, toTimestamp, type SheetTable } from "@/lib/tabular";

describe("toNumber", () => {
  it("普通数字与带符号数字", () => {
    expect(toNumber("42")).toBe(42);
    expect(toNumber("-3.5")).toBe(-3.5);
    expect(toNumber("+7")).toBe(7);
    expect(toNumber(" 1.25 ")).toBe(1.25);
    expect(toNumber("1e3")).toBe(1000);
  });

  it("千分位逗号剥掉后再读", () => {
    expect(toNumber("1,234.5")).toBe(1234.5);
    expect(toNumber("1,000,000")).toBe(1000000);
  });

  it("百分号只当单位标记剥掉，不除以 100", () => {
    // 一列 "12%","45%" 的用户期望均值是 28.5，而不是 0.285
    expect(toNumber("12%")).toBe(12);
    expect(toNumber("-4.5%")).toBe(-4.5);
  });

  it("空、纯空白、非数字、非有限值一律 null", () => {
    for (const value of ["", "   ", "N/A", "-", "abc", "12abc", "Infinity", "NaN", "%"]) {
      expect(toNumber(value), value).toBeNull();
    }
  });
});

describe("toTimestamp", () => {
  it("接受 YYYY-MM-DD 与 YYYY/MM/DD，可带时间", () => {
    expect(toTimestamp("2024-01-02")).toBe(Date.UTC(2024, 0, 2));
    expect(toTimestamp("2024/01/02")).toBe(Date.UTC(2024, 0, 2));
    expect(toTimestamp("2024-01-02 03:04:05")).toBe(Date.UTC(2024, 0, 2, 3, 4, 5));
    expect(toTimestamp("2024-01-02T03:04")).toBe(Date.UTC(2024, 0, 2, 3, 4));
  });

  it("不认识的写法一律 null —— 宁可漏认也不要认错", () => {
    // Date.parse 会把这些当日期，从而把一列备注误判成日期列
    for (const value of ["01/02/2024", "1/2", "2024", "2024年1月2日", "", "abc"]) {
      expect(toTimestamp(value), value).toBeNull();
    }
  });

  it("不存在的日期不被 Date.UTC 的滚动兜过去", () => {
    expect(toTimestamp("2024-02-31")).toBeNull();
    expect(toTimestamp("2024-13-01")).toBeNull();
  });
});

describe("inferColumnType", () => {
  it("全空列判 empty", () => {
    expect(inferColumnType(["", "  ", ""])).toBe("empty");
    expect(inferColumnType([])).toBe("empty");
  });

  it("过半是数字就算数值列 —— 混着 N/A 的数值列不该被降级成文本", () => {
    expect(inferColumnType(["1", "2", "3"])).toBe("number");
    expect(inferColumnType(["1", "2", "N/A"])).toBe("number");
    // 正好一半不算过半
    expect(inferColumnType(["1", "N/A"])).toBe("text");
  });

  it("过半是日期就算日期列", () => {
    expect(inferColumnType(["2024-01-02", "2024-06-30", "待定"])).toBe("date");
  });

  it("空单元格不参与投票", () => {
    expect(inferColumnType(["1", "", "", ""])).toBe("number");
  });

  it("数字优先于日期（2024 这种四位串不该被当日期）", () => {
    expect(inferColumnType(["2024", "2025"])).toBe("number");
  });
});

describe("toDataTable", () => {
  const sheet = (rows: string[][]): SheetTable => ({ sheets: ["Sheet1"], name: "Sheet1", rows, truncated: false });

  it("首行当表头，其余为数据行", () => {
    const table = toDataTable(
      sheet([
        ["name", "qty"],
        ["a", "1"],
        ["b", "2"],
      ]),
    );
    expect(table.columns.map((column) => column.name)).toEqual(["name", "qty"]);
    expect(table.columns.map((column) => column.index)).toEqual([0, 1]);
    expect(table.columns.map((column) => column.type)).toEqual(["text", "number"]);
    expect(table.rows).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("空表头回落为「列 N」，不留无名列", () => {
    const table = toDataTable(
      sheet([
        ["", "qty"],
        ["a", "1"],
      ]),
    );
    expect(table.columns.map((column) => column.name)).toEqual(["列 1", "qty"]);
  });

  it("空表（无行）不炸，返回零列", () => {
    const table = toDataTable(sheet([]));
    expect(table.columns).toEqual([]);
    expect(table.rows).toEqual([]);
  });

  it("只有表头时没有数据行", () => {
    const table = toDataTable(sheet([["name", "qty"]]));
    expect(table.columns).toHaveLength(2);
    expect(table.rows).toEqual([]);
    // 无数据 → 列类型为 empty
    expect(table.columns.map((column) => column.type)).toEqual(["empty", "empty"]);
  });

  it("短行按缺格补空，不越界", () => {
    const table = toDataTable(sheet([["a", "b", "c"], ["1"], ["2", "3"]]));
    expect(table.columns).toHaveLength(3);
    expect(table.rows).toEqual([["1"], ["2", "3"]]);
    expect(table.columns[2].type).toBe("empty");
  });

  it("保留工作表信息与截断标记", () => {
    const table = toDataTable({ sheets: ["A", "B"], name: "B", rows: [["x"], ["1"]], truncated: true });
    expect(table.sheets).toEqual(["A", "B"]);
    expect(table.sheetName).toBe("B");
    expect(table.truncated).toBe(true);
  });
});
