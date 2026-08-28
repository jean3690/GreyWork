import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { xlsxToUniverWorkbook } from "./univer-xlsx";

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
});
