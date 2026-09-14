/**
 * 表格选区采集的纯逻辑。
 *
 * 这里能测而 SheetViewer 测不了：Univer 在 happy-dom 里跑不起来，所以组件那一层
 * 只留接线，凡是能判对错的计算都在本文件覆盖。假 sheet 只实现三个访问器 —— 这也正是
 * `SheetLike` 接口存在的意义。
 */
import { describe, expect, it } from "vitest";
import {
  columnLabel,
  formatCellText,
  formatRangeLabel,
  formatSelectionTsv,
  MAX_SELECTION_COLUMNS,
  readRangeSelection,
  type SheetLike,
} from "@/lib/sheet-selection";

interface FakeCell {
  v?: unknown;
  f?: string | null;
}

/** `getCell` 只给显示值、`getCellRaw` 给原始值 + 公式 —— 与 Univer 的实际分层一致。 */
function fakeSheet(name: string, cells: Record<string, FakeCell> = {}): SheetLike {
  const lookup = (row: number, col: number): FakeCell | null => cells[`${row},${col}`] ?? null;
  return {
    getName: () => name,
    getCell: (row, col) => {
      const cell = lookup(row, col);
      return cell ? { v: cell.v } : null;
    },
    getCellRaw: (row, col) => lookup(row, col),
  };
}

describe("columnLabel", () => {
  it.each<[number, string]>([
    [0, "A"],
    [1, "B"],
    [25, "Z"],
    [26, "AA"],
    [27, "AB"],
    [51, "AZ"],
    [52, "BA"],
    [701, "ZZ"],
    [702, "AAA"],
  ])("列号 %i → %s", (index, label) => {
    expect(columnLabel(index)).toBe(label);
  });

  it("负数与小数被夹回 A，不产出空串", () => {
    expect(columnLabel(-5)).toBe("A");
    expect(columnLabel(1.7)).toBe("B");
  });
});

describe("formatRangeLabel", () => {
  it("单格不带区间", () => {
    expect(formatRangeLabel("Sheet1", { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 })).toBe("Sheet1!A1");
  });

  it("区域给出起止，行列对外都是 1 起", () => {
    expect(formatRangeLabel("数据", { startRow: 0, startColumn: 0, endRow: 2, endColumn: 2 })).toBe("数据!A1:C3");
  });
});

describe("formatCellText", () => {
  it("只有值", () => {
    expect(formatCellText(120, null)).toBe("120");
  });

  it("空单元格是空串（不是 undefined 字面量）", () => {
    expect(formatCellText(undefined, null)).toBe("");
    expect(formatCellText(null, null)).toBe("");
  });

  it("有公式时把公式附在值后面 —— 只有结果的表格对模型没什么用", () => {
    expect(formatCellText(120, "=SUM(A1:A3)")).toBe("120 (=SUM(A1:A3))");
  });

  it("有公式没缓存值时只给公式，不产出「 (=…)」这种残句", () => {
    expect(formatCellText(undefined, "=SUM(A1:A3)")).toBe("=SUM(A1:A3)");
  });
});

describe("readRangeSelection", () => {
  it("按矩形采集值与公式", () => {
    const sheet = fakeSheet("Sheet1", {
      "0,0": { v: "名称" },
      "0,1": { v: "数量" },
      "1,0": { v: "苹果" },
      "1,1": { v: 3 },
      "2,1": { v: 120, f: "=SUM(B2:B2)" },
    });

    const selection = readRangeSelection(sheet, { startRow: 0, startColumn: 0, endRow: 2, endColumn: 1 });

    expect(selection.label).toBe("Sheet1!A1:B3");
    expect(selection.sheetName).toBe("Sheet1");
    expect(selection.truncated).toBe(false);
    expect(selection.rows).toEqual([
      ["名称", "数量"],
      ["苹果", "3"],
      ["", "120 (=SUM(B2:B2))"],
    ]);
  });

  it("列数超过上限时截断并如实标记", () => {
    const sheet = fakeSheet("S", {});
    const selection = readRangeSelection(sheet, {
      startRow: 0,
      startColumn: 0,
      endRow: 0,
      endColumn: MAX_SELECTION_COLUMNS + 49,
    });

    expect(selection.truncated).toBe(true);
    expect(selection.rows[0]).toHaveLength(MAX_SELECTION_COLUMNS);
  });

  it("总单元格数超过上限时按行截断（留整行，不留半行）", () => {
    const sheet = fakeSheet("S", {});
    const selection = readRangeSelection(sheet, { startRow: 0, startColumn: 0, endRow: 99, endColumn: 49 });

    expect(selection.truncated).toBe(true);
    // 2000 / 50 列 = 40 行
    expect(selection.rows).toHaveLength(40);
    expect(selection.rows.every((row) => row.length === 50)).toBe(true);
  });
});

describe("formatSelectionTsv", () => {
  it("制表符分隔、换行分行", () => {
    const sheet = fakeSheet("S", { "0,0": { v: "a" }, "0,1": { v: "b" }, "1,0": { v: 1 } });
    const selection = readRangeSelection(sheet, { startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 });

    expect(formatSelectionTsv(selection)).toBe("a\tb\n1\t");
  });

  it("被截断时在末尾明说，不静默少给数据", () => {
    const sheet = fakeSheet("S", {});
    const selection = readRangeSelection(sheet, { startRow: 0, startColumn: 0, endRow: 99, endColumn: 49 });
    const tsv = formatSelectionTsv(selection);

    expect(tsv).toContain("[选区过大，仅包含前 40 行 × 50 列]");
  });

  it("未截断时不加任何说明行", () => {
    const sheet = fakeSheet("S", { "0,0": { v: "only" } });
    const selection = readRangeSelection(sheet, { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 });

    expect(formatSelectionTsv(selection)).toBe("only");
  });
});
