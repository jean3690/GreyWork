import { cellDisplayValue } from "./xlsx-values";
import { sanitizeXlsxGraphics } from "./xlsx-sanitize";
import type { SheetTable } from "./tabular";
import type { Worksheet } from "exceljs";

/**
 * xlsx 导出 / 追加 / 轻量预览。exceljs 是这里唯一的重量级依赖 —— 静态 import 会把
 * 它焊进任何静态引用本模块的 chunk（会话 store 链从 Shell 直达，等于焊进出入口，
 * 从不产表格的用户开屏就要解析）。所以每个入口函数内部再 `import("exceljs")`，
 * 让这份 ~1MB 的写入器自然落到独立 chunk，只在真正产出/读取 xlsx 时才加载。
 */

/** 一张工作表的声明式描述：headers + rows（单元格字符串原样写入，公式如 "=SUM(A1:A3)" 生效）。 */
export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: string[][];
}

/** 内联产物卡片的 xlsx 轻量预览（M8）：首个工作表前若干行的字符串网格 + 工作表总数。 */
export interface XlsxPreview {
  rows: string[][];
  sheetCount: number;
}

const EXCEL_SHEET_MAX = 31;

/**
 * 将结构化数据渲染为 xlsx 二进制（exceljs）。
 * 首行加粗 + 自动筛选 + 数据区域列宽自适应；公式字符串按原样写入由 Excel 求值。
 */
export async function exportToXlsx(sheets: XlsxSheet[]): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  // exceljs 拒绝写零工作表的工作簿；空输入补一张占位表（与 pptx 空 deck 补封面同理）。
  const inputs = sheets.length > 0 ? sheets : [{ name: "Sheet", headers: [], rows: [] }];
  // 净化后的 sheet 名可能撞车（截断到 31 字、清洗非法字符、空名都回落 "Sheet"），
  // 而 exceljs 的 addWorksheet 撞名即抛 —— 整个导出会失败而不是产出部分。逐张去重。
  const used = new Set<string>();
  for (const input of inputs) {
    const worksheet = workbook.addWorksheet(dedupeSheetName(sanitizeSheetName(input.name), used));
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
        worksheet.getColumn(column).width = columnWidth(input, column - 1);
      }
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/**
 * 给现有 xlsx 追加一行（无则按 headers 新建），返回新字节。
 * 读取路径同样要过 sanitize：磁盘上的文件可能带 openpyxl 风格图纸，
 * exceljs 的 dist 在 reconcile 阶段会崩。
 */
export async function appendXlsxRow(data: Uint8Array | null, sheetName: string, headers: string[], row: string[]): Promise<Uint8Array> {
  if (!data) return exportToXlsx([{ name: sheetName, headers, rows: [row] }]);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await sanitizeXlsxGraphics(data));
  // 按名字定位目标表（净化名与原名都试）；不存在就新建并补表头 —— 否则新表缺表头、列对不上。
  // 旧实现固定写 worksheet(1)，`sheetName` 形同虚设：请求追加到「汇总」会静默落到首个表。
  const clean = sanitizeSheetName(sheetName);
  let sheet = workbook.getWorksheet(clean) ?? workbook.worksheets.find((worksheet) => worksheet.name === sheetName);
  if (!sheet) {
    sheet = workbook.addWorksheet(clean);
    if (headers.length > 0) sheet.addRow(headers).font = { bold: true };
  }
  sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/** 工作表名净化；导出与回写共用（回写时改名同样不能带非法字符或超 31 字）。 */
export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, "").slice(0, EXCEL_SHEET_MAX);
  return cleaned.length > 0 ? cleaned : "Sheet";
}

/** 将二维结果集（首行为表头）转为 XlsxSheet 声明。 */
export function rowsToSheet(name: string, headers: string[], rows: string[][]): XlsxSheet {
  return { name, headers, rows };
}

/**
 * 读取 xlsx 二进制的轻量预览（M8）：返回首个工作表前 maxRows 行的字符串网格与
 * 工作表总数，供消息流内联产物卡片渲染，避免为内联视图拉起完整 Univer。
 */
export async function readXlsxPreview(data: Uint8Array, maxRows = 12): Promise<XlsxPreview> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await sanitizeXlsxGraphics(data));
  const first = workbook.worksheets[0];
  if (!first) return { rows: [], sheetCount: 0 };
  return { rows: gridOf(first, maxRows).rows, sheetCount: workbook.worksheets.length };
}

/** 分析模式读表的行上限，与宿主 `sheet.rs` 的 MAX_ROWS 对齐 —— 两条通道口径一致，用户才不会看到「同样大的表，xlsx 能分析、xls 说被截断」。 */
const XLSX_TABLE_MAX_ROWS = 20_000;

/**
 * 读取 xlsx 的完整网格（供数据分析用）。
 *
 * 与 `readXlsxPreview` 分开而不是加个参数：后者的契约是「前 12 行的内联卡片预览」，
 * 两者在行数、工作表选择、截断语义上完全不同，共用一个函数只会让两边都别扭。
 *
 * 读之前必须过 `sanitizeXlsxGraphics`：磁盘上的文件可能带 openpyxl 风格图纸，
 * exceljs 的 dist 在 reconcile 阶段会崩（见 xlsx-sanitize 的说明）。
 * `sheetName` 不存在时回落首个工作表，与宿主 calamine 通道同一行为。
 */
export async function readXlsxTable(data: Uint8Array, sheetName?: string, maxRows = XLSX_TABLE_MAX_ROWS): Promise<SheetTable> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await sanitizeXlsxGraphics(data));

  const sheets = workbook.worksheets.map((worksheet) => worksheet.name);
  const target = workbook.worksheets.find((worksheet) => worksheet.name === sheetName) ?? workbook.worksheets[0];
  if (!target) return { sheets: [], name: "", rows: [], truncated: false };

  const { rows, truncated } = gridOf(target, maxRows);
  return { sheets, name: target.name, rows, truncated };
}

/** 撞名消歧：在 31 字预算内追加 " (2)"、" (3)"… 直到不重复。 */
function dedupeSheetName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const candidate = name.slice(0, EXCEL_SHEET_MAX - suffix.length) + suffix;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

const COL_WIDTH_MIN = 8;
const COL_WIDTH_MAX = 40;

/**
 * 数据区域列宽自适应：单遍扫过该列取最长串长度，夹在 [8, 40]。
 * 不用 `Math.max(...arr)` 展开：几十万行的表会把上万个参数铺进调用栈直接 RangeError，
 * 也免掉逐列重建整列数组的分配（原实现是 O(列 × 行) 且每列都新起数组）。
 */
function columnWidth(sheet: XlsxSheet, columnIndex: number): number {
  let max = String(sheet.headers[columnIndex] ?? "").length;
  for (const row of sheet.rows) {
    const length = String(row[columnIndex] ?? "").length;
    if (length > max) {
      max = length;
      if (max >= COL_WIDTH_MAX) break;
    }
  }
  return Math.min(Math.max(max, COL_WIDTH_MIN), COL_WIDTH_MAX);
}

/**
 * 逐行读成字符串网格，保留空行（不折叠间隙），行数封顶 maxRows。
 *
 * 用 `getRow(n)` 而非 `eachRow`：后者只访问非空行、`rowNumber` 却是真实行号，顺序 push
 * 会把「1、3 行有值、2 行空」压成相邻两行、整体上移 —— 分析通道据此读表会错位。
 * `eachRow` 还无法在 maxRows 处停手，稀疏大表会白扫到末行。这里以真实行数封顶并逐行取。
 */
function gridOf(sheet: Worksheet, maxRows: number): { rows: string[][]; truncated: boolean } {
  const total = sheet.rowCount;
  const limit = Math.min(total, maxRows);
  const rows: string[][] = [];
  for (let n = 1; n <= limit; n += 1) {
    const values = sheet.getRow(n).values;
    // Row.values 是 1 基数组（[0]=行号），切片去掉行号；空行运行时非数组，落成空行占位。
    rows.push(Array.isArray(values) ? values.slice(1).map((cell) => cellDisplayValue(cell)) : []);
  }
  return { rows, truncated: total > maxRows };
}
