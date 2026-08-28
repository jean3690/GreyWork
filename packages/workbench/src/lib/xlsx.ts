import ExcelJS from "exceljs";

/** 一张工作表的声明式描述：headers + rows（单元格字符串原样写入，公式如 "=SUM(A1:A3)" 生效）。 */
export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: string[][];
}

const EXCEL_SHEET_MAX = 31;

/**
 * 将结构化数据渲染为 xlsx 二进制（exceljs）。
 * 首行加粗 + 自动筛选 + 数据区域列宽自适应；公式字符串按原样写入由 Excel 求值。
 */
export async function exportToXlsx(sheets: XlsxSheet[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  for (const input of sheets) {
    const worksheet = workbook.addWorksheet(sanitizeSheetName(input.name));
    const headerRow = worksheet.addRow(input.headers);
    headerRow.font = { bold: true };
    for (const row of input.rows) worksheet.addRow(row);
    if (input.headers.length > 0) {
      const lastRow = Math.max(input.rows.length + 1, 1);
      worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: lastRow, column: input.headers.length },
      };
      for (let column = 1; column <= input.headers.length; column += 1) {
        const width = Math.min(
          Math.max(
            ...[input.headers[column - 1] ?? "", ...input.rows.map((row) => row[column - 1] ?? "")].map((cell) => String(cell).length),
            8,
          ),
          40,
        );
        worksheet.getColumn(column).width = width;
      }
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, "").slice(0, EXCEL_SHEET_MAX);
  return cleaned.length > 0 ? cleaned : "Sheet";
}

/** 将二维结果集（首行为表头）转为 XlsxSheet 声明。 */
export function rowsToSheet(name: string, headers: string[], rows: string[][]): XlsxSheet {
  return { name, headers, rows };
}
