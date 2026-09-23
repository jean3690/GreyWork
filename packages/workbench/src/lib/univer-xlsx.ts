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
import type { Alignment, Border, Borders, Cell, Worksheet } from "exceljs";
import type { IWorkbookData, IWorksheetData, ICellData, IStyleData, IColorStyle, IBorderData } from "@univerjs/core";
import { sanitizeXlsxGraphics } from "./xlsx-sanitize";
import { isRecord } from "./guards";
import { normalizeCellValue } from "./xlsx-values";

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
  // openpyxl 等写入器的 drawing 部件会让 exceljs(浏览器 dist)在 reconcile 崩溃,
  // 图纸图表预览本来就不渲染,读前先剥掉
  await exceljs.xlsx.load(await sanitizeXlsxGraphics(data));

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
        const value = normalizeCellValue(cell.value, toExcelSerial);
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

/* ===== 反向：Univer → xlsx（保存回写用） ===== */

/**
 * Univer 样式枚举名 → excel 对齐串。style 里存的是枚举**数值**，靠 enums 反查名字再落到
 * excel 的字符串。`H_ALIGN` 把多个 excel 值折到同一个 Univer 枚举（distributed→JUSTIFIED），
 * 反向只取一个规范值即可 —— 往返成 justify 而非 distributed 是可接受的近似。
 */
function excelHorizontal(ht: number | null | undefined | void, enums: UniverEnums): Alignment["horizontal"] | undefined {
  if (ht == null) return undefined;
  if (ht === enums.HorizontalAlign.LEFT) return "left";
  if (ht === enums.HorizontalAlign.CENTER) return "center";
  if (ht === enums.HorizontalAlign.RIGHT) return "right";
  if (ht === enums.HorizontalAlign.JUSTIFIED) return "justify";
  return undefined;
}

function excelVertical(vt: number | null | undefined | void, enums: UniverEnums): Alignment["vertical"] | undefined {
  if (vt == null) return undefined;
  if (vt === enums.VerticalAlign.TOP) return "top";
  if (vt === enums.VerticalAlign.MIDDLE) return "middle";
  if (vt === enums.VerticalAlign.BOTTOM) return "bottom";
  return undefined;
}

/** Univer 枚举名 → excel 边框粗细名。`BORDER_STYLE` 是 excel→Univer 名，这里取其首个逆映射。 */
const BORDER_STYLE_TO_EXCEL: Record<string, Border["style"]> = (() => {
  const out: Record<string, Border["style"]> = {};
  for (const [excel, univer] of Object.entries(BORDER_STYLE)) if (!(univer in out)) out[univer] = excel as Border["style"];
  return out;
})();

function excelBorderStyle(s: number | null | undefined | void, enums: UniverEnums): Border["style"] | undefined {
  if (s == null) return undefined;
  for (const [name, value] of Object.entries(enums.BorderStyleTypes)) {
    if (value === s) return BORDER_STYLE_TO_EXCEL[name] ?? "thin";
  }
  return undefined;
}

/** Univer 颜色（`#RRGGBB`）→ exceljs argb（`FFRRGGBB`）。非法值不给，宁缺毋错。 */
function toArgb(color: IColorStyle | null | undefined | void): string | undefined {
  const rgb = color?.rgb;
  if (typeof rgb !== "string") return undefined;
  const hex = rgb.replace(/^#/, "");
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? `FF${hex.toUpperCase()}` : undefined;
}

/** IStyleData → exceljs 单元格样式的逆映射（`toStyle` 的对应还原，缺项即用默认，不抛）。 */
function applyUniverStyle(cell: Cell, style: IStyleData, enums: UniverEnums): void {
  const font: Partial<Cell["font"]> = {};
  if (typeof style.ff === "string") font.name = style.ff;
  if (typeof style.fs === "number") font.size = style.fs;
  if (style.bl === enums.BooleanNumber.TRUE) font.bold = true;
  if (style.it === enums.BooleanNumber.TRUE) font.italic = true;
  if (style.ul?.s === enums.BooleanNumber.TRUE) font.underline = true;
  if (style.st?.s === enums.BooleanNumber.TRUE) font.strike = true;
  const fontColor = toArgb(style.cl);
  if (fontColor) font.color = { argb: fontColor };
  if (Object.keys(font).length > 0) cell.font = font as Cell["font"];

  const bg = toArgb(style.bg);
  if (bg) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };

  const alignment: Partial<Alignment> = {};
  const horizontal = excelHorizontal(style.ht, enums);
  if (horizontal) alignment.horizontal = horizontal;
  const vertical = excelVertical(style.vt, enums);
  if (vertical) alignment.vertical = vertical;
  if (style.tb === enums.WrapStrategy.WRAP) alignment.wrapText = true;
  if (Object.keys(alignment).length > 0) cell.alignment = alignment;

  const border = style.bd;
  if (border) {
    const sides: [keyof IBorderData, keyof Borders][] = [
      ["t", "top"],
      ["r", "right"],
      ["b", "bottom"],
      ["l", "left"],
    ];
    const out: Partial<Borders> = {};
    for (const [key, excelSide] of sides) {
      const side = border[key];
      if (!side) continue;
      const styleName = excelBorderStyle(side.s, enums);
      if (!styleName) continue;
      out[excelSide] = { style: styleName, color: { argb: toArgb(side.cl) ?? "FF000000" } };
    }
    if (Object.keys(out).length > 0) cell.border = out;
  }

  if (style.n?.pattern) cell.numFmt = style.n.pattern;
}

/** cell.s：可能是样式池 id，也可能是内联 IStyleData。 */
function resolveStyle(ref: ICellData["s"], styles: IWorkbookData["styles"]): IStyleData | undefined {
  if (!ref) return undefined;
  if (typeof ref === "string") return isRecord(styles) ? (styles[ref] as IStyleData | undefined) : undefined;
  return isRecord(ref) ? (ref as IStyleData) : undefined;
}

/**
 * Univer workbook 快照 → xlsx 二进制（`xlsxToUniverWorkbook` 的反向，保存回写用）。
 *
 * **只重建单元格层**：值 / 公式 / 样式 / 合并 / 冻结 / 行列尺寸。图纸图表媒体在读入时已被
 * `sanitizeXlsxGraphics` 剥掉、exceljs 的 dist 写入器本也不写回，故含图元的表由保存入口
 * （SheetViewer）用 `hasGraphicsParts` 拦下，绝不静默丢弃。日期在读入时已存成序列号 + 数字格式，
 * 这里原样写回数字即可，Excel 靠 numFmt 仍显示成日期。
 */
export async function univerWorkbookToXlsx(workbook: IWorkbookData): Promise<Uint8Array> {
  const [core, ExcelJS] = await Promise.all([import("@univerjs/core"), import("exceljs")]);
  const enums: UniverEnums = {
    BooleanNumber: core.BooleanNumber as unknown as UniverEnums["BooleanNumber"],
    HorizontalAlign: core.HorizontalAlign as unknown as UniverEnums["HorizontalAlign"],
    VerticalAlign: core.VerticalAlign as unknown as UniverEnums["VerticalAlign"],
    WrapStrategy: core.WrapStrategy as unknown as UniverEnums["WrapStrategy"],
    BorderStyleTypes: core.BorderStyleTypes as unknown as UniverEnums["BorderStyleTypes"],
  };

  const out = new ExcelJS.Workbook();
  const order = workbook.sheetOrder.length > 0 ? workbook.sheetOrder : Object.keys(workbook.sheets);
  for (const sheetId of order) {
    const sheet = workbook.sheets[sheetId];
    if (!sheet) continue;
    const ws = out.addWorksheet(sheet.name || sheetId);

    const cellData = sheet.cellData ?? {};
    for (const [rowKey, columns] of Object.entries(cellData)) {
      const rowIndex = Number(rowKey);
      if (!isRecord(columns)) continue;
      for (const [colKey, uCell] of Object.entries(columns)) {
        if (!isRecord(uCell)) continue;
        const cell = ws.getCell(rowIndex + 1, Number(colKey) + 1);
        const formula = typeof uCell.f === "string" && uCell.f.startsWith("=") ? uCell.f.slice(1) : null;
        const value = uCell.v;
        if (formula) {
          cell.value = { formula, result: (value ?? undefined) as number | string | boolean | undefined };
        } else if (value !== undefined && value !== null) {
          cell.value = value as number | string | boolean;
        }
        const style = resolveStyle(uCell.s as ICellData["s"], workbook.styles);
        if (style) applyUniverStyle(cell, style, enums);
      }
    }

    for (const merge of sheet.mergeData ?? []) {
      ws.mergeCells(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1);
    }

    for (const [colKey, dim] of Object.entries(sheet.columnData ?? {})) {
      if (!isRecord(dim)) continue;
      const column = ws.getColumn(Number(colKey) + 1);
      if (typeof dim.w === "number") column.width = Math.max((dim.w - COLUMN_PADDING_PX) / PX_PER_CHAR, 1);
      if (dim.hd === enums.BooleanNumber.TRUE) column.hidden = true;
    }
    for (const [rowKey, dim] of Object.entries(sheet.rowData ?? {})) {
      if (!isRecord(dim)) continue;
      const row = ws.getRow(Number(rowKey) + 1);
      if (typeof dim.h === "number") row.height = dim.h / PX_PER_PT;
      if (dim.hd === enums.BooleanNumber.TRUE) row.hidden = true;
    }

    if (sheet.freeze && (sheet.freeze.xSplit > 0 || sheet.freeze.ySplit > 0)) {
      ws.views = [{ state: "frozen", xSplit: sheet.freeze.xSplit, ySplit: sheet.freeze.ySplit }];
    }
  }

  const buffer = await out.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
