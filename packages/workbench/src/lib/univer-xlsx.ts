/**
 * xlsx → Univer IWorkbookData 转换（产物查看器渲染用）。
 *
 * 为什么表格仍走 Univer 而 docx / pptx 改成自渲染：电子表格要的是虚拟化网格 —— 滚动、
 * 冻结窗格、列宽行高、数万行不卡。这套自己写不划算，而 Univer 的网格正是它最成熟的部分。
 * 之前预览「看着不像原文」的原因不在 Univer，而在这个转换器：`styles: {}` 一片空白，
 * 合并、列宽、数字格式、公式结果全部丢在门外。本文件负责把它们补齐。
 *
 * 单位约定：Excel 列宽是「字符宽度」，行高是磅；Univer 两者都要 px。
 */
import type { Cell, Worksheet } from "exceljs";
import type { IWorkbookData, IWorksheetData, ICellData, IStyleData, IColorStyle, IBorderData } from "@univerjs/core";

type CellValue = string | number | boolean;

/** Excel 列宽 1 单位 ≈ 7px 字形宽 + 5px 内边距（Excel 的默认字体度量）。 */
const PX_PER_CHAR = 7;
const COLUMN_PADDING_PX = 5;
/** 磅 → px。 */
const PX_PER_PT = 96 / 72;
/** 网格最小尺寸：只铺到数据边界的话，预览看起来像个小方块而不是电子表格。 */
const MIN_ROWS = 100;
const MIN_COLUMNS = 26;

/**
 * Excel 日期序列号的纪元取 1899-12-30。
 *
 * 差两天不是笔误：Excel 把 1900 当闰年（沿用 Lotus 1-2-3 的错），1900-03-01 起的序列号
 * 整体多 1 天，纪元退到 12-30 正好抵掉。校准点：2000-01-01 → 36526，与 Excel 一致。
 * 1900-03-01 之前的日期会差 1 天 —— 那段区间里 Excel 自己的序列号就是错的，
 * 而预览面对的是现实业务数据，不为一段不存在的日期去做特例。
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

function toExcelSerial(date: Date): number {
  return (date.getTime() - EXCEL_EPOCH_MS) / MS_PER_DAY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * exceljs 的 cell.value 有七种形态，逐一拆解。
 *
 * 旧实现只认 `{ text }` 与「结果是字符串的公式」，其余一律落到 `String(value)` ——
 * 于是数值公式、富文本、错误值在预览里全变成 `[object Object]`。
 */
function toCellValue(value: unknown): CellValue | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return toExcelSerial(value);
  if (!isRecord(value)) return String(value);

  // 公式 / 共享公式：取缓存结果（预览不重算），结果本身可能又是错误值或日期
  if ("result" in value) return toCellValue(value.result);
  // 富文本：拼接各片段的文字（片段级样式在单元格级别表达不了，取并集意义不大）
  const richText = value.richText;
  if (Array.isArray(richText)) {
    return richText.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
  }
  // 超链接：{ text, hyperlink }
  if (typeof value.text === "string") return value.text;
  // 错误值：{ error: "#DIV/0!" }
  if (typeof value.error === "string") return value.error;
  return undefined;
}

/* ===== 样式 ===== */

/** exceljs 颜色（argb / theme）→ Univer 颜色。主题色需要 theme1.xml 才能解析，宁可不给也不给错。 */
function toColor(color: unknown): IColorStyle | undefined {
  if (!isRecord(color)) return undefined;
  const argb = color.argb;
  if (typeof argb !== "string") return undefined;
  // argb 是 8 位（FFRRGGBB）；6 位的也容忍
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? { rgb: `#${hex.toUpperCase()}` } : undefined;
}

interface UniverEnums {
  BooleanNumber: { TRUE: number; FALSE: number };
  HorizontalAlign: Record<string, number>;
  VerticalAlign: Record<string, number>;
  WrapStrategy: Record<string, number>;
  BorderStyleTypes: Record<string, number>;
}

const H_ALIGN: Record<string, keyof UniverEnums["HorizontalAlign"]> = {
  left: "LEFT",
  center: "CENTER",
  right: "RIGHT",
  justify: "JUSTIFIED",
  distributed: "JUSTIFIED",
};

const V_ALIGN: Record<string, string> = {
  top: "TOP",
  middle: "MIDDLE",
  bottom: "BOTTOM",
};

/** Excel 的边框粗细名 → Univer 的枚举名。 */
const BORDER_STYLE: Record<string, string> = {
  thin: "THIN",
  hair: "HAIR",
  dotted: "DOTTED",
  dashed: "DASHED",
  dashDot: "DASH_DOT",
  dashDotDot: "DASH_DOT_DOT",
  medium: "MEDIUM",
  mediumDashed: "MEDIUM_DASHED",
  mediumDashDot: "MEDIUM_DASH_DOT",
  mediumDashDotDot: "MEDIUM_DASH_DOT_DOT",
  thick: "THICK",
  double: "DOUBLE",
  slantDashDot: "THIN",
};

function toBorder(border: unknown, enums: UniverEnums): IBorderData | undefined {
  if (!isRecord(border)) return undefined;
  const sides: [keyof IBorderData, string][] = [
    ["t", "top"],
    ["r", "right"],
    ["b", "bottom"],
    ["l", "left"],
  ];
  const out: IBorderData = {};
  let any = false;
  for (const [key, source] of sides) {
    const side = border[source];
    if (!isRecord(side) || typeof side.style !== "string") continue;
    const styleName = BORDER_STYLE[side.style] ?? "THIN";
    out[key] = {
      s: enums.BorderStyleTypes[styleName] ?? enums.BorderStyleTypes.THIN,
      cl: toColor(side.color) ?? { rgb: "#000000" },
    };
    any = true;
  }
  return any ? out : undefined;
}

/** exceljs 单元格样式 → Univer IStyleData；返回 undefined 表示「纯默认样式」，不必占一条。 */
function toStyle(cell: Cell, enums: UniverEnums): IStyleData | undefined {
  const style: IStyleData = {};
  const font = isRecord(cell.font) ? cell.font : undefined;
  if (font) {
    if (typeof font.name === "string") style.ff = font.name;
    if (typeof font.size === "number") style.fs = font.size;
    if (font.bold) style.bl = enums.BooleanNumber.TRUE;
    if (font.italic) style.it = enums.BooleanNumber.TRUE;
    if (font.underline) style.ul = { s: enums.BooleanNumber.TRUE };
    if (font.strike) style.st = { s: enums.BooleanNumber.TRUE };
    const color = toColor(font.color);
    if (color) style.cl = color;
  }

  // 只认 solid 填充：渐变/图案填充在 Univer 单元格上没有对应表达
  const fill = isRecord(cell.fill) ? cell.fill : undefined;
  if (fill?.type === "pattern" && fill.pattern === "solid") {
    const bg = toColor(fill.fgColor);
    if (bg) style.bg = bg;
  }

  const alignment = isRecord(cell.alignment) ? cell.alignment : undefined;
  if (alignment) {
    const horizontal = typeof alignment.horizontal === "string" ? H_ALIGN[alignment.horizontal] : undefined;
    if (horizontal) style.ht = enums.HorizontalAlign[horizontal];
    const vertical = typeof alignment.vertical === "string" ? V_ALIGN[alignment.vertical] : undefined;
    if (vertical) style.vt = enums.VerticalAlign[vertical];
    if (alignment.wrapText) style.tb = enums.WrapStrategy.WRAP;
  }

  const border = toBorder(cell.border, enums);
  if (border) style.bd = border;

  // 数字格式交给 Univer 渲染：日期已按序列号存入，靠 pattern 才能显示成 2026-09-04
  if (typeof cell.numFmt === "string" && cell.numFmt !== "General") style.n = { pattern: cell.numFmt };

  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * 样式去重表。
 *
 * 必须去重：一张表几万个单元格常常共用同一套样式，逐格内联会把快照撑到几十 MB，
 * Univer 载入时也要为每格建一份样式对象。
 */
class StylePool {
  private readonly byKey = new Map<string, string>();
  readonly styles: Record<string, IStyleData> = {};

  idOf(style: IStyleData | undefined): string | undefined {
    if (!style) return undefined;
    const key = JSON.stringify(style);
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const id = `s${this.byKey.size + 1}`;
    this.byKey.set(key, id);
    this.styles[id] = style;
    return id;
  }
}

/* ===== 结构 ===== */

/** `B3` / `AB12` → 0 基行列号。 */
function parseCellRef(ref: string): { row: number; column: number } | null {
  const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref.trim());
  if (!match) return null;
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + (char.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, column: column - 1 };
}

/** exceljs 的合并区（`"A1:B2"`）→ Univer IRange。 */
function parseMerges(sheet: Worksheet): IWorksheetData["mergeData"] {
  const raw = (sheet.model as { merges?: unknown }).merges;
  if (!Array.isArray(raw)) return [];
  const out: IWorksheetData["mergeData"] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const [from, to] = entry.split(":");
    const start = parseCellRef(from ?? "");
    const end = parseCellRef(to ?? from ?? "");
    if (!start || !end) continue;
    out.push({
      startRow: Math.min(start.row, end.row),
      endRow: Math.max(start.row, end.row),
      startColumn: Math.min(start.column, end.column),
      endColumn: Math.max(start.column, end.column),
    });
  }
  return out;
}

/** 冻结窗格：Excel 的 xSplit/ySplit 就是冻结的列数/行数。 */
function parseFreeze(sheet: Worksheet): IWorksheetData["freeze"] | undefined {
  const view = sheet.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
  if (view?.state !== "frozen") return undefined;
  const xSplit = view.xSplit ?? 0;
  const ySplit = view.ySplit ?? 0;
  if (xSplit <= 0 && ySplit <= 0) return undefined;
  return { xSplit, ySplit, startRow: ySplit, startColumn: xSplit };
}

interface Dimensions {
  rowData: Record<number, { h?: number; hd?: number }>;
  columnData: Record<number, { w?: number; hd?: number }>;
}

function readDimensions(sheet: Worksheet, enums: UniverEnums): Dimensions {
  const rowData: Dimensions["rowData"] = {};
  const columnData: Dimensions["columnData"] = {};

  sheet.columns?.forEach((column, index) => {
    const entry: { w?: number; hd?: number } = {};
    if (typeof column?.width === "number") entry.w = Math.round(column.width * PX_PER_CHAR + COLUMN_PADDING_PX);
    if (column?.hidden) entry.hd = enums.BooleanNumber.TRUE;
    if (entry.w !== undefined || entry.hd !== undefined) columnData[index] = entry;
  });

  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const entry: { h?: number; hd?: number } = {};
    if (typeof row.height === "number" && row.height > 0) entry.h = Math.round(row.height * PX_PER_PT);
    if (row.hidden) entry.hd = enums.BooleanNumber.TRUE;
    if (entry.h !== undefined || entry.hd !== undefined) rowData[rowNumber - 1] = entry;
  });

  return { rowData, columnData };
}

/* ===== 主流程 ===== */

/** 读取 xlsx 二进制并转换为 Univer workbook 快照。 */
export async function xlsxToUniverWorkbook(data: Uint8Array): Promise<IWorkbookData> {
  const [core, ExcelJS] = await Promise.all([import("@univerjs/core"), import("exceljs")]);
  const enums: UniverEnums = {
    BooleanNumber: core.BooleanNumber as unknown as UniverEnums["BooleanNumber"],
    HorizontalAlign: core.HorizontalAlign as unknown as UniverEnums["HorizontalAlign"],
    VerticalAlign: core.VerticalAlign as unknown as UniverEnums["VerticalAlign"],
    WrapStrategy: core.WrapStrategy as unknown as UniverEnums["WrapStrategy"],
    BorderStyleTypes: core.BorderStyleTypes as unknown as UniverEnums["BorderStyleTypes"],
  };

  const exceljs = new ExcelJS.Workbook();
  const view = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  await exceljs.xlsx.load(view);

  const sheets: IWorkbookData["sheets"] = {};
  const sheetOrder: string[] = [];
  const pool = new StylePool();

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
        const styleId = pool.idOf(toStyle(cell, enums));
        // 空值但有样式（表头底色、边框框出来的区域）也要留格，否则版式塌掉
        if (value === undefined && styleId === undefined) return;
        const entry: ICellData = {};
        if (value !== undefined) entry.v = value;
        if (styleId !== undefined) entry.s = styleId;
        cellData[rowIndex] = cellData[rowIndex] ?? {};
        cellData[rowIndex][colIndex] = entry;
        maxRow = Math.max(maxRow, rowIndex);
        maxCol = Math.max(maxCol, colIndex);
      });
    });

    const { rowData, columnData } = readDimensions(sheet, enums);
    const freeze = parseFreeze(sheet);
    sheets[sheetId] = {
      id: sheetId,
      name: sheet.name,
      rowCount: Math.max(maxRow + 20, MIN_ROWS),
      columnCount: Math.max(maxCol + 5, MIN_COLUMNS),
      cellData,
      mergeData: parseMerges(sheet),
      rowData,
      columnData,
      ...(freeze ? { freeze } : {}),
    };
  });

  return {
    id: `wb-${Date.now()}`,
    name: "产物",
    appVersion: "0.1.0",
    locale: core.LocaleType.ZH_CN,
    styles: pool.styles,
    sheetOrder,
    sheets,
  };
}
