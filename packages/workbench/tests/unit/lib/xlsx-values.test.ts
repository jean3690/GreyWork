import { describe, expect, it } from "vitest";
import { cellDisplayValue, normalizeCellValue } from "@/lib/xlsx-values";

/**
 * 这两份语义此前各有一份实现，univer 侧认得富文本/错误值，文字矩阵侧不认。
 * 合到一处后，下面的用例就是「两份不再分叉」的闸门。
 */
describe("normalizeCellValue", () => {
  it("标量原样返回，null / undefined 视为空单元格", () => {
    expect(normalizeCellValue("a", String)).toBe("a");
    expect(normalizeCellValue(1, String)).toBe(1);
    expect(normalizeCellValue(true, String)).toBe(true);
    expect(normalizeCellValue(null, String)).toBeUndefined();
    expect(normalizeCellValue(undefined, String)).toBeUndefined();
  });

  it("日期交给调用方决定形态：Univer 要序列号，文字网格要 ISO", () => {
    const date = new Date("2026-09-05T00:00:00.000Z");
    expect(normalizeCellValue(date, (d) => d.toISOString())).toBe("2026-09-05T00:00:00.000Z");
    expect(normalizeCellValue(date, (d) => d.getUTCFullYear())).toBe(2026);
  });

  it("公式取缓存结果，结果本身是日期也照样交出去", () => {
    expect(normalizeCellValue({ formula: "SUM(1,2)", result: 3 }, String)).toBe(3);
    const date = new Date("2026-09-05T00:00:00.000Z");
    expect(normalizeCellValue({ formula: "TODAY()", result: date }, (d) => d.toISOString())).toBe("2026-09-05T00:00:00.000Z");
  });

  it("富文本拼接、超链接取文字、错误值取错误码", () => {
    expect(normalizeCellValue({ richText: [{ text: "红" }, { text: "蓝" }] }, String)).toBe("红蓝");
    expect(normalizeCellValue({ text: "官网", hyperlink: "https://example.com" }, String)).toBe("官网");
    expect(normalizeCellValue({ error: "#DIV/0!" }, String)).toBe("#DIV/0!");
  });
});

describe("cellDisplayValue", () => {
  it("空单元格是空串", () => {
    expect(cellDisplayValue(null)).toBe("");
    expect(cellDisplayValue(undefined)).toBe("");
  });

  it("标量转字符串", () => {
    expect(cellDisplayValue(4281)).toBe("4281");
    expect(cellDisplayValue(false)).toBe("false");
  });

  it("富文本 / 错误值拿到真实内容，不是 [object Object]", () => {
    expect(cellDisplayValue({ richText: [{ text: "红" }, { text: "蓝" }] })).toBe("红蓝");
    expect(cellDisplayValue({ error: "#DIV/0!" })).toBe("#DIV/0!");
  });
});
