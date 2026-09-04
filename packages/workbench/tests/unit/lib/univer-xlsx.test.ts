import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { xlsxToUniverWorkbook } from "@/lib/univer-xlsx";

async function buildXlsx(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("客流");
  sheet.addRow(["站点", "客流"]);
  sheet.addRow(["北京站", 4281]);
  sheet.addRow(["上海站", 3650]);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

describe("xlsxToUniverWorkbook", () => {
  it("映射 sheet 名、sheetOrder 与 cellData（数字索引，值类型保留）", async () => {
    const data = await buildXlsx();
    const workbook = await xlsxToUniverWorkbook(data);

    expect(workbook.sheetOrder).toEqual(["sheet-1"]);
    expect(workbook.sheets["sheet-1"]?.name).toBe("客流");

    const cellData = workbook.sheets["sheet-1"]?.cellData;
    expect(cellData?.[0]?.[0]?.v).toBe("站点");
    expect(cellData?.[0]?.[1]?.v).toBe("客流");
    expect(cellData?.[1]?.[0]?.v).toBe("北京站");
    expect(cellData?.[1]?.[1]?.v).toBe(4281); // 数字类型保留
    expect(cellData?.[2]?.[1]?.v).toBe(3650);
  });

  it("rowCount/columnCount 覆盖实际数据", async () => {
    const data = await buildXlsx();
    const workbook = await xlsxToUniverWorkbook(data);
    const sheet = workbook.sheets["sheet-1"];
    expect(sheet?.rowCount).toBeGreaterThanOrEqual(3);
    expect(sheet?.columnCount).toBeGreaterThanOrEqual(2);
  });

  it("公式 / 富文本 / 错误值取到真实内容，不再是 [object Object]", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("值形态");
    sheet.getCell("A1").value = { formula: "SUM(1,2)", result: 3 } as never;
    sheet.getCell("A2").value = { formula: 'A1&"x"', result: "3x" } as never;
    sheet.getCell("A3").value = { richText: [{ text: "红" }, { text: "蓝" }] } as never;
    sheet.getCell("A4").value = { text: "官网", hyperlink: "https://example.com" } as never;
    sheet.getCell("A5").value = { error: "#DIV/0!" } as never;
    const parsed = await xlsxToUniverWorkbook(new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer));

    const cells = parsed.sheets["sheet-1"]?.cellData;
    // 数值公式结果曾经落到 String(value) 变成 [object Object]
    expect(cells?.[0]?.[0]?.v).toBe(3);
    expect(cells?.[1]?.[0]?.v).toBe("3x");
    expect(cells?.[2]?.[0]?.v).toBe("红蓝");
    expect(cells?.[3]?.[0]?.v).toBe("官网");
    expect(cells?.[4]?.[0]?.v).toBe("#DIV/0!");
  });

  it("日期转成 Excel 序列号并带上数字格式（否则只能显示 ISO 字符串）", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("日期");
    const cell = sheet.getCell("A1");
    cell.value = new Date(Date.UTC(2026, 8, 4));
    cell.numFmt = "yyyy-mm-dd";
    const parsed = await xlsxToUniverWorkbook(new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer));

    const entry = parsed.sheets["sheet-1"]?.cellData?.[0]?.[0];
    // 1899-12-30 纪元：2026-09-04 = 46269（同一算法下 2000-01-01 = 36526，与 Excel 一致）
    expect(entry?.v).toBe(46269);
  });

  it("单元格样式进 styles 表并按内容去重（同样式共用一个 id）", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("样式");
    for (const ref of ["A1", "B1"]) {
      const cell = sheet.getCell(ref);
      cell.value = ref;
      cell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C1917" } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FFE7E5E4" } } };
    }
    const parsed = await xlsxToUniverWorkbook(new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer));

    const cells = parsed.sheets["sheet-1"]?.cellData;
    const idA = cells?.[0]?.[0]?.s;
    const idB = cells?.[0]?.[1]?.s;
    expect(typeof idA).toBe("string");
    // 去重是刚需：几万格共用一套样式时逐格内联会把快照撑爆
    expect(idA).toBe(idB);

    const style = parsed.styles?.[idA as string];
    expect(style?.bl).toBe(1);
    expect(style?.fs).toBe(14);
    expect(style?.cl).toEqual({ rgb: "#FFFFFF" });
    expect(style?.bg).toEqual({ rgb: "#1C1917" });
    expect(style?.bd?.b?.cl).toEqual({ rgb: "#E7E5E4" });
    expect(style?.ht).toBeTypeOf("number");
    expect(style?.vt).toBeTypeOf("number");
    expect(style?.tb).toBeTypeOf("number");
  });

  it("合并区、列宽、行高、冻结窗格都带过去", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("版式");
    sheet.getCell("A1").value = "跨列标题";
    sheet.addRow(["甲", "乙", "丙"]);
    sheet.mergeCells("A1:C1");
    sheet.getColumn(1).width = 20;
    sheet.getRow(1).height = 30;
    sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
    const parsed = await xlsxToUniverWorkbook(new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer));

    const sheetData = parsed.sheets["sheet-1"];
    expect(sheetData?.mergeData).toEqual([{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 }]);
    // 20 字符宽 → 20*7+5
    expect(sheetData?.columnData?.[0]?.w).toBe(145);
    // 30pt → 40px
    expect(sheetData?.rowData?.[0]?.h).toBe(40);
    expect(sheetData?.freeze).toMatchObject({ xSplit: 1, ySplit: 1 });
  });

  it("空值但带样式的单元格要留格（表头底色/边框框出的区域不能塌掉）", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("空样式");
    const cell = sheet.getCell("B2");
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } };
    const parsed = await xlsxToUniverWorkbook(new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer));

    const entry = parsed.sheets["sheet-1"]?.cellData?.[1]?.[1];
    expect(entry?.v).toBeUndefined();
    expect(parsed.styles?.[entry?.s as string]?.bg).toEqual({ rgb: "#FF0000" });
  });
});
