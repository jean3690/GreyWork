/**
 * xlsx → Univer IWorkbookData 转换（产物查看器视觉渲染用）。
 *
 * exceljs 读回 xlsx，映射为 Univer 的 workbook 快照结构（cellData 数字索引）。
 * Univer 相关依赖均动态 import，保持懒加载独立 chunk；此处仅做类型引用。
 */
import type { ICellData, IWorkbookData } from "@univerjs/core";

type CellValue = string | number | boolean;

function toCellValue(value: unknown): CellValue | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    // exceljs 复合值：{ text } / { richText } / { formula, result }
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.formula !== undefined && typeof record.result === "string") return record.result;
    return String(value);
  }
  return String(value);
}

/** 读取 xlsx 二进制并转换为 Univer workbook 快照。 */
export async function xlsxToUniverWorkbook(data: Uint8Array): Promise<IWorkbookData> {
  const [{ LocaleType }, ExcelJS] = await Promise.all([import("@univerjs/core"), import("exceljs")]);

  const exceljs = new ExcelJS.Workbook();
  const view = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  await exceljs.xlsx.load(view);

  const sheets: IWorkbookData["sheets"] = {};
  const sheetOrder: string[] = [];

  exceljs.eachSheet((sheet, id) => {
    const sheetId = `sheet-${id}`;
    sheetOrder.push(sheetId);
    const cellData: Record<number, Record<number, ICellData>> = {};
    let maxRow = 0;
    let maxCol = 0;
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const rowIndex = rowNumber - 1;
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const colIndex = colNumber - 1;
        const value = toCellValue(cell.value);
        if (value === undefined) return;
        cellData[rowIndex] = cellData[rowIndex] ?? {};
        cellData[rowIndex][colIndex] = { v: value };
        maxRow = Math.max(maxRow, rowIndex);
        maxCol = Math.max(maxCol, colIndex);
      });
    });
    sheets[sheetId] = {
      id: sheetId,
      name: sheet.name,
      rowCount: maxRow + 2,
      columnCount: maxCol + 2,
      cellData,
    };
  });

  return {
    id: `wb-${Date.now()}`,
    name: "产物",
    appVersion: "0.1.0",
    locale: LocaleType.ZH_CN,
    styles: {},
    sheetOrder,
    sheets,
  };
}
