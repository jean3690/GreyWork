import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { appendXlsxRow, exportToXlsx, readXlsxPreview, readXlsxTable, rowsToSheet } from "@/lib/xlsx";

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

describe("readXlsxTable（数据分析用）", () => {
  const sample = () =>
    exportToXlsx([
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

  it("读回全部行（不像内联预览那样截到 12 行），并带上全部工作表名", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`row${i + 1}`]);
    const data = await exportToXlsx([{ name: "s", headers: ["h"], rows }]);
    const table = await readXlsxTable(data);
    expect(table.rows).toHaveLength(31);
    expect(table.name).toBe("s");
    expect(table.sheets).toEqual(["s"]);
    expect(table.truncated).toBe(false);
  });

  it("按名字选工作表；名字不存在时回落首个（与宿主 calamine 通道同行为）", async () => {
    const data = await sample();
    expect((await readXlsxTable(data, "备注")).name).toBe("备注");
    expect((await readXlsxTable(data, "不存在")).name).toBe("客流");
    expect((await readXlsxTable(data)).rows).toEqual([
      ["站点", "value"],
      ["北京站", "1284"],
      ["上海站", "876"],
    ]);
  });

  it("超过 maxRows 时截断并标记", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => [`row${i + 1}`]);
    const data = await exportToXlsx([{ name: "s", headers: ["h"], rows }]);
    const table = await readXlsxTable(data, undefined, 3);
    expect(table.rows).toHaveLength(3);
    expect(table.truncated).toBe(true);
  });

  it("空工作簿返回空网格", async () => {
    const workbook = new ExcelJS.Workbook();
    const buffer = await workbook.xlsx.writeBuffer();
    expect(await readXlsxTable(new Uint8Array(buffer as ArrayBuffer))).toEqual({ sheets: [], name: "", rows: [], truncated: false });
  });
});

describe("exportToXlsx 撞名与空输入", () => {
  it("净化后同名的多表逐一消歧，不因 exceljs 重名而整体抛错", async () => {
    const data = await exportToXlsx([
      { name: "报表", headers: ["h"], rows: [["a"]] },
      { name: "报表", headers: ["h"], rows: [["b"]] },
      { name: "报表", headers: ["h"], rows: [["c"]] },
    ]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(["报表", "报表 (2)", "报表 (3)"]);
  });

  it("空输入产出带占位表的合法工作簿（对齐 pptx 空 deck 行为），而非抛错", async () => {
    const data = await exportToXlsx([]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
    expect(workbook.worksheets).toHaveLength(1);
  });
});

describe("读表保留空行", () => {
  it("中间空行不折叠、后续行不上移（分析通道据此对齐）", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("s");
    sheet.addRow(["h1", "h2"]); // 第 1 行
    sheet.getCell("A3").value = "a"; // 第 3 行，第 2 行留空
    sheet.getCell("B3").value = "b";
    const buffer = await workbook.xlsx.writeBuffer();
    const table = await readXlsxTable(new Uint8Array(buffer as ArrayBuffer));
    expect(table.rows).toEqual([["h1", "h2"], [], ["a", "b"]]);
  });
});

describe("appendXlsxRow", () => {
  it("无数据：按 headers 新建目标表并写入首行数据", async () => {
    const created = await appendXlsxRow(null, "汇总", ["站点", "客流"], ["北京", "100"]);
    const table = await readXlsxTable(created, "汇总");
    expect(table.name).toBe("汇总");
    expect(table.rows).toEqual([
      ["站点", "客流"],
      ["北京", "100"],
    ]);
  });

  it("已有文件：按名字追加到同名表", async () => {
    const created = await appendXlsxRow(null, "汇总", ["站点", "客流"], ["北京", "100"]);
    const appended = await appendXlsxRow(created, "汇总", ["站点", "客流"], ["上海", "200"]);
    expect((await readXlsxTable(appended, "汇总")).rows).toEqual([
      ["站点", "客流"],
      ["北京", "100"],
      ["上海", "200"],
    ]);
  });

  it("目标表不存在时新建并补表头，不静默落到首个表", async () => {
    const base = await exportToXlsx([{ name: "first", headers: ["h"], rows: [["x"]] }]);
    const table = await readXlsxTable(await appendXlsxRow(base, "second", ["a"], ["y"]), "second");
    expect(table.sheets).toEqual(["first", "second"]);
    expect(table.rows).toEqual([["a"], ["y"]]);
  });
});
