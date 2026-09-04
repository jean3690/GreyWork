import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { exportToXlsx, readXlsxPreview, rowsToSheet } from "@/lib/xlsx";

describe("exportToXlsx", () => {
  it("生成的二进制可被 exceljs 读回：表头加粗、数据行、公式字符串原样、自动筛选", async () => {
    const data = await exportToXlsx([
      {
        name: "客流",
        headers: ["站点", "value"],
        rows: [
          ["北京站", "1284"],
          ["上海站", "=SUM(C1)"],
          ["深圳站", "876"],
        ],
      },
    ]);
    expect(data.byteLength).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet("客流");
    expect(sheet).toBeDefined();
    expect(sheet!.getCell("A1").value).toBe("站点");
    expect(sheet!.getCell("B1").value).toBe("value");
    expect(sheet!.getRow(1).font?.bold).toBe(true);
    expect(sheet!.getCell("A2").value).toBe("北京站");
    // 公式字符串按原样写入，交由 Excel 求值
    expect(sheet!.getCell("B3").value).toBe("=SUM(C1)");
    expect(sheet!.autoFilter).toBeDefined();
  });

  it("多 sheet 各自独立，sheet 名超长截断且清洗非法字符", async () => {
    const data = await exportToXlsx([
      { name: "报表一", headers: ["h"], rows: [["a"]] },
      { name: `${"x".repeat(40)}/[\\?*:]`, headers: ["h"], rows: [] },
    ]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
    expect(workbook.worksheets).toHaveLength(2);
    expect(workbook.worksheets[1]?.name).toBe("x".repeat(31));
  });

  it("空 sheet 名回退 Sheet，空 rows 也能生成", async () => {
    const data = await exportToXlsx([{ name: "", headers: ["a", "b"], rows: [] }]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
    expect(workbook.worksheets[0]?.name).toBe("Sheet");
    expect(workbook.worksheets[0]?.getCell("A1").value).toBe("a");
  });
});

describe("rowsToSheet", () => {
  it("结构化二维数组转 XlsxSheet 声明", () => {
    expect(rowsToSheet("s", ["h1", "h2"], [["v1", "v2"]])).toEqual({
      name: "s",
      headers: ["h1", "h2"],
      rows: [["v1", "v2"]],
    });
  });
});

describe("readXlsxPreview（M8 内联预览）", () => {
  it("读回首个工作表的字符串网格与工作表总数", async () => {
    const data = await exportToXlsx([
      {
        name: "客流",
        headers: ["站点", "value"],
        rows: [
          ["北京站", "1284"],
          ["上海站", "876"],
        ],
      },
      { name: "备注", headers: ["x"], rows: [["y"]] },
    ]);
    const preview = await readXlsxPreview(data);
    expect(preview.rows).toEqual([
      ["站点", "value"],
      ["北京站", "1284"],
      ["上海站", "876"],
    ]);
    expect(preview.sheetCount).toBe(2);
  });

  it("默认截断 12 行，可自定义 maxRows", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`row${i + 1}`]);
    const data = await exportToXlsx([{ name: "s", headers: ["h"], rows }]);
    expect((await readXlsxPreview(data)).rows).toHaveLength(12);
    expect((await readXlsxPreview(data, 3)).rows).toHaveLength(3);
  });

  it("空工作簿返回空预览", async () => {
    const workbook = new ExcelJS.Workbook();
    const buffer = await workbook.xlsx.writeBuffer();
    expect(await readXlsxPreview(new Uint8Array(buffer as ArrayBuffer))).toEqual({ rows: [], sheetCount: 0 });
  });
});
