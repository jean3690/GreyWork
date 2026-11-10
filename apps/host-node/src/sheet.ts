/**
 * 表格文件的宿主解析通道：移植 `crates/greywork-host/src/infra/sheet.rs`。
 *
 * **为什么在宿主而不是渲染端**：老格式 `.xls` 是 OLE2/BIFF 二进制，渲染端没有任何
 * 可用的解析器 —— exceljs 与 Univer 都只认 xlsx。JS 侧唯一的全能解析器是 SheetJS，
 * 而官方 npm 包停在 0.18.5（带两个未修复 CVE，且已停止发布）。这里用 `@e965/xlsx`
 * —— SheetJS CE 0.20.3 的社区维护 fork（含 CVE 修复），一次覆盖 xls / xlsx / xlsb；
 * ODS 不走它（其日期单元格会丢失 ODF 的 ISO 原文形态），单独实现解析器以对齐
 * calamine 的 `DateTimeIso` / `DurationIso` 输出。
 *
 * **按内容嗅探而非扩展名**：zip（PK）先看 mimetype 是否 ODS，其余交给 SheetJS 自试，
 * 于是 `.xlt`（模板）和「名为 .xls 实为 xlsx」这类真实存在的错名文件都能正确读。
 *
 * **只解析，不做表头语义**：首行是否表头由渲染端决定（`lib/tabular.ts` 与 CSV 同口径）。
 * 这里只把单元格值归一成展示字符串。
 *
 * **数值/日期显示口径逐条移植 calamine 0.36.1**：
 * - `formats.rs::detect_custom_number_format` / `builtin_format_by_code`（日期 vs 时长）；
 * - `datatype.rs::excel_to_standard_datetime`（序列值 → 年月日时分秒，含 1900 闰年 bug）；
 * - `datatype.rs::datetime_to_string`（sheet.rs 顶部的展示格式化）。
 */
import { readFileSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

import * as XLSX from "@e965/xlsx";

/** 解析前的字节上限，与 `workspace_fs::fs_read_binary` 对齐。 */
const MAX_SHEET_BYTES = 20 * 1024 * 1024;
/** 回传行数上限。 */
export const MAX_ROWS = 20_000;
/** 回传列数上限，理由同上。 */
export const MAX_COLS = 128;

export interface SheetTable {
  /** 工作簿里全部工作表名（按工作簿顺序），供渲染端做切换器。 */
  sheets: string[];
  /** 本次返回的是哪一张。 */
  name: string;
  /** 行 × 列的展示字符串网格（含首行）。 */
  rows: string[][];
  /** 是否因 `MAX_ROWS` / `MAX_COLS` 被截断。 */
  truncated: boolean;
}

export interface ReadSheetArgs {
  path: string;
  sheet?: string | null;
  maxRows?: number | null;
}

/* ===== calamine `formats.rs` 的移植：数字格式 → 日期/时长分类 ===== */

export type CellFormat = "datetime" | "timedelta" | "other";

/** `detect_custom_number_format` 的逐行移植：从格式串本体判定（首个分号前）。 */
export function detectCustomNumberFormat(format: string): CellFormat {
  let escaped = false;
  let isQuote = false;
  let brackets = 0;
  let prev = " ";
  let hms = false;
  let ap = false;
  for (const s of format) {
    if (escaped) {
      escaped = false;
    } else if (s === "_" || s === "\\" || s === "*") {
      escaped = true;
    } else if (isQuote) {
      if (s === '"') isQuote = false;
    } else if (s === '"') {
      isQuote = true;
    } else if (s === ";") {
      return "other"; // 只看第一个格式段
    } else if (s === "[") {
      brackets += 1;
    } else if (s === "]" && brackets === 1 && hms) {
      return "timedelta";
    } else if (s === "]") {
      brackets = Math.max(0, brackets - 1);
    } else if ((s === "a" || s === "A") && !ap && brackets === 0) {
      ap = true;
    } else if ((s === "p" || s === "m" || s === "/" || s === "P" || s === "M") && ap && brackets === 0) {
      return "datetime";
    } else if ("dmhysDMHYS".includes(s) && !ap && brackets === 0) {
      return "datetime";
    } else if (hms && s.toLowerCase() === prev.toLowerCase()) {
      // ok ...（重复的 h/m/s 计数符）
    } else {
      hms = prev === "[" && "mhsmhs".includes(s);
    }
    prev = s;
  }
  return "other";
}

/* ===== calamine `datatype.rs` 的移植：序列值 → 日期分量 ===== */

const YEAR_DAYS = 365;
const YEAR_DAYS_4 = 1461;
const YEAR_DAYS_100 = 36524;
const YEAR_DAYS_400 = 146097;
const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;
const MINUTE_SECONDS = 60;

/** Excel 序列值 → [year, month, day, hour, minute, second]（`excel_to_standard_datetime` 移植）。 */
export function excelToStandardDatetime(excelDatetime: number, is1904: boolean): [number, number, number, number, number, number] {
  const months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  let days = Math.floor(excelDatetime);
  if (is1904) {
    days += 111_033;
  } else if (days > YEAR_DAYS) {
    days += 109_571;
  } else {
    // 1900 闰年 bug 补偿。
    days += 109_572;
  }

  let yearDays400 = days / YEAR_DAYS_400;
  days = days % YEAR_DAYS_400;
  yearDays400 = Math.floor(yearDays400);

  let yearDays100: number;
  if (days < YEAR_DAYS_100) {
    yearDays100 = Math.floor(days / YEAR_DAYS_100);
    days %= YEAR_DAYS_100;
  } else {
    yearDays100 = 1 + Math.floor((days - YEAR_DAYS_100) / (YEAR_DAYS_100 - 1));
    days = (days - YEAR_DAYS_100) % (YEAR_DAYS_100 - 1);
  }

  let yearDays4: number;
  let nonLeapYearBlock = false;
  if (yearDays100 === 0) {
    yearDays4 = Math.floor(days / YEAR_DAYS_4);
    days %= YEAR_DAYS_4;
  } else if (days < YEAR_DAYS_4) {
    yearDays4 = Math.floor(days / (YEAR_DAYS_4 - 1));
    days %= YEAR_DAYS_4 - 1;
    nonLeapYearBlock = true;
  } else {
    yearDays4 = 1 + Math.floor((days - (YEAR_DAYS_4 - 1)) / YEAR_DAYS_4);
    days = (days - (YEAR_DAYS_4 - 1)) % YEAR_DAYS_4;
  }

  let yearDays1: number;
  if (nonLeapYearBlock) {
    yearDays1 = Math.floor(days / YEAR_DAYS);
    days %= YEAR_DAYS;
  } else if (days < YEAR_DAYS + 1) {
    yearDays1 = Math.floor(days / (YEAR_DAYS + 1));
    days %= YEAR_DAYS + 1;
  } else {
    yearDays1 = 1 + Math.floor((days - (YEAR_DAYS + 1)) / YEAR_DAYS);
    days = (days - (YEAR_DAYS + 1)) % YEAR_DAYS;
  }

  const year = 1600 + yearDays400 * 400 + yearDays100 * 100 + yearDays4 * 4 + yearDays1;
  days += 1;

  const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (isLeap) months[1] = 29;

  if (!is1904 && year === 1900) {
    months[1] = 29;
    if (Math.trunc(excelDatetime) === 366) days += 1;
  }

  let month = 1;
  for (const monthDays of months) {
    if (days > monthDays) {
      days -= monthDays;
      month += 1;
    } else {
      break;
    }
  }
  const day = days;

  const time = excelDatetime % 1;
  const milli = Math.round(((time * DAY_SECONDS) % 1) * 1000);
  let dayAsSeconds = Math.trunc(time * DAY_SECONDS);
  if (milli === 1000) {
    dayAsSeconds += 1;
  }

  const hour = Math.floor(dayAsSeconds / HOUR_SECONDS);
  const minute = Math.floor((dayAsSeconds - hour * HOUR_SECONDS) / MINUTE_SECONDS);
  const second = (dayAsSeconds - hour * HOUR_SECONDS - minute * MINUTE_SECONDS) % MINUTE_SECONDS;
  return [year, month, day, hour, minute, second];
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

/** Excel 日期/时间序列值 → 展示字符串（sheet.rs `datetime_to_string` 移植）。 */
export function datetimeToString(value: number, isDuration: boolean, is1904: boolean): string {
  if (isDuration) {
    const seconds = Math.max(0, Math.round(value * DAY_SECONDS));
    return `${pad2(Math.floor(seconds / 3600))}:${pad2(Math.floor(seconds / 60) % 60)}:${pad2(seconds % 60)}`;
  }
  const [year, month, day, hour, minute, second] = excelToStandardDatetime(value, is1904);
  const clock = `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  if (value < 1) return clock;
  if (clock === "00:00:00") return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
  return `${pad4(year)}-${pad2(month)}-${pad2(day)} ${clock}`;
}

/** Rust `f64::to_string` 风格：指数形态展开成纯小数（两边的最短有效数字一致）。 */
export function rustFloatString(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);
  const s = String(value);
  if (!/[eE]/.test(s)) return s;
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [mantissa, expText] = body.split(/[eE]/);
  const exponent = Number(expText);
  const dot = mantissa.indexOf(".");
  const digits = mantissa.replace(".", "");
  const point = (dot === -1 ? mantissa.length : dot) + exponent;
  let out: string;
  if (point <= 0) {
    out = `0.${"0".repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    out = digits + "0".repeat(point - digits.length);
  } else {
    out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  return negative ? `-${out}` : out;
}

/* ===== 最小 zip 读取：嗅探 mimetype、抽取 ODS 的 content.xml ===== */

/** 在 zip 字节里按名字取条目（store / deflate），找不到返回 null。 */
function zipReadEntry(zip: Buffer, wanted: string): Buffer | null {
  const eocd = zip.lastIndexOf("PK\x05\x06");
  if (eocd < 0) return null;
  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < entryCount; i += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.slice(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === wanted) {
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = zip.slice(dataStart, dataStart + compressedSize);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/* ===== ODS 解析（对齐 calamine `ods.rs` 的取值语义） ===== */

function decodeXmlEntities(text: string): string {
  return text
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replaceAll(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** 单元格取值（`ods.rs::get_datatype` 的属性优先级：value > date-value > time-value > string-value > boolean-value）。 */
function odsCellValue(attrs: string, inner: string): string {
  const read = (name: string): string | null => {
    const match = attrs.match(new RegExp(`${name}="([^"]*)"`));
    return match ? decodeXmlEntities(match[1]) : null;
  };
  const numeric = read("office:value");
  if (numeric !== null) return rustFloatString(Number(numeric));
  const date = read("office:date-value");
  if (date !== null) return date;
  const duration = read("office:time-value");
  if (duration !== null) return duration;
  const bool = read("office:boolean-value");
  if (bool !== null) return bool === "TRUE" || bool === "true" ? "TRUE" : "FALSE";
  const stringValue = read("office:string-value");
  if (stringValue !== null) return stringValue;
  // value-type="string" 且无 string-value：元素内容即值（text:p / text:s / text:tab / text:line-break）。
  return decodeXmlEntities(
    inner
      .replaceAll(/<text:tab\b[^>]*\/>/g, "\t")
      .replaceAll(/<text:line-break\b[^>]*\/>/g, "\n")
      .replaceAll(/<text:s\b([^>]*?)\/>/g, (_, extra: string) => {
        const count = extra.match(/text:c="(\d+)"/);
        return " ".repeat(count ? Number(count[1]) : 1);
      })
      .replaceAll(/<[^>]*>/g, ""),
  );
}

interface OdsSheet {
  name: string;
  rows: string[][];
}

/** 解析 content.xml：返回按文档顺序的全部工作表网格（已按使用范围裁齐、去尾部空行）。 */
export function parseOdsContent(contentXml: string): OdsSheet[] {
  const sheets: OdsSheet[] = [];
  const tablePattern = /<table:table(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table>)/g;
  for (const tableMatch of contentXml.matchAll(tablePattern)) {
    const nameMatch = tableMatch[1].match(/table:name="([^"]*)"/);
    const name = nameMatch ? decodeXmlEntities(nameMatch[1]) : "";
    const body = tableMatch[2] ?? "";
    const sparseRows = new Map<number, string[]>();
    let rowIndex = 0;
    let maxUsedCol = -1;
    const rowPattern = /<table:table-row(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g;
    for (const rowMatch of body.matchAll(rowPattern)) {
      const rowRepeat = Math.max(1, Number(rowMatch[1].match(/table:number-rows-repeated="(\d+)"/)?.[1] ?? 1));
      const cells: string[] = [];
      let colIndex = 0;
      let hasContent = false;
      const cellPattern = /<(table:table-cell|table:covered-table-cell)(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
      for (const cellMatch of body.slice(rowMatch.index, rowMatch.index + rowMatch[0].length).matchAll(cellPattern)) {
        const isCovered = cellMatch[1] === "table:covered-table-cell";
        const repeat = Math.max(1, Number(cellMatch[2].match(/table:number-columns-repeated="(\d+)"/)?.[1] ?? 1));
        const value = isCovered ? "" : odsCellValue(cellMatch[2], cellMatch[3] ?? "");
        if (value !== "") {
          hasContent = true;
          for (let i = 0; i < repeat; i += 1) cells[colIndex + i] = value;
          maxUsedCol = Math.max(maxUsedCol, colIndex + repeat - 1);
        }
        colIndex += repeat;
      }
      if (hasContent) {
        // 重复的空行段先落位：同一段被重复的行里只有这一行有内容。
        for (let i = 1; i < rowRepeat; i += 1) {
          if (!sparseRows.has(rowIndex + i)) sparseRows.set(rowIndex + i, []);
        }
        sparseRows.set(rowIndex, cells);
      }
      rowIndex += rowRepeat;
    }
    const totalRows = sparseRows.size === 0 ? 0 : Math.max(...sparseRows.keys()) + 1;
    const rows: string[][] = [];
    for (let r = 0; r < totalRows; r += 1) {
      const row = sparseRows.get(r) ?? [];
      const padded: string[] = [];
      for (let c = 0; c <= maxUsedCol; c += 1) padded.push(row[c] ?? "");
      rows.push(padded);
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

/* ===== SheetJS（xls / xlsx / xlsb）路径 ===== */

interface XlsxCell {
  t?: string;
  v?: unknown;
  z?: string;
}

function xlsxCellToString(cell: XlsxCell | undefined, is1904: boolean): string {
  if (!cell || cell.v === undefined || cell.v === null) return "";
  const value = cell.v;
  switch (cell.t) {
    case "s":
    case "str":
      return String(value);
    case "b":
      return value === true ? "TRUE" : "FALSE";
    case "e":
      return String(value);
    case "n": {
      if (typeof value !== "number") return String(value);
      // 数字格式分类：与 calamine 一致（SheetJS 只给格式串，不给 builtin 号，
      // 但用同一判定器跑格式串得到的分类完全一致 —— 见模块头注释）。
      const format = cell.z ? detectCustomNumberFormat(String(cell.z)) : "other";
      if (format === "datetime") return datetimeToString(value, false, is1904);
      if (format === "timedelta") return datetimeToString(value, true, is1904);
      return rustFloatString(value);
    }
    case "d":
      // cellDates 关闭时不该出现；防御性兜底按序列值处理。
      return datetimeToString((value as Date).getTime() / DAY_SECONDS / 1000 + 25569, false, is1904);
    default:
      return "";
  }
}

function decodeRange(ref: string): { rows: number; cols: number } {
  const [start, end = start] = ref.split(":");
  const decode = (part: string): { r: number; c: number } => {
    const match = part.match(/^([A-Z]+)(\d+)$/);
    if (!match) return { r: 0, c: 0 };
    let c = 0;
    for (const ch of match[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    return { r: Number(match[2]) - 1, c: c - 1 };
  };
  const from = decode(start);
  const to = decode(end);
  return { rows: to.r - from.r + 1, cols: to.c - from.c + 1 };
}

function encodeCellAddress(row: number, col: number): string {
  let c = col + 1;
  let letters = "";
  while (c > 0) {
    const rem = (c - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    c = Math.floor((c - 1) / 26);
  }
  return `${letters}${row + 1}`;
}

function readSheetFromWorkbookBytes(bytes: Buffer, sheet: string | null | undefined, maxRows: number): SheetTable {
  const workbook = XLSX.read(bytes, {
    type: "buffer",
    cellNF: true,
    cellDates: false,
    cellText: false,
    sheetStubs: false,
  });
  return tableFromWorkbook(workbook, sheet, maxRows);
}

function tableFromWorkbook(workbook: XLSX.WorkBook, sheet: string | null | undefined, maxRows: number): SheetTable {
  const sheets = workbook.SheetNames;
  if (sheets.length === 0) throw new Error("文件里没有工作表");
  const name = sheet !== null && sheet !== undefined && sheets.includes(sheet) ? sheet : sheets[0];
  const worksheet = workbook.Sheets[name];
  const is1904 = Boolean((workbook.Workbook as { WBProps?: { date1904?: unknown } } | undefined)?.WBProps?.date1904);

  const rows: string[][] = [];
  let truncated = false;
  if (worksheet && worksheet["!ref"]) {
    const dimension = decodeRange(worksheet["!ref"] as string);
    const columnCount = Math.min(dimension.cols, MAX_COLS);
    truncated = dimension.rows > maxRows || dimension.cols > MAX_COLS;
    for (let r = 0; r < Math.min(dimension.rows, maxRows); r += 1) {
      const row: string[] = [];
      for (let c = 0; c < columnCount; c += 1) {
        row.push(xlsxCellToString(worksheet[encodeCellAddress(r, c)] as XlsxCell | undefined, is1904));
      }
      rows.push(row);
    }
  }
  return { sheets, name, rows, truncated };
}

/* ===== 入口 ===== */

/** 从字节解析出指定工作表（sheet.rs `read_sheet_from_bytes` 同形态）。 */
export function readSheetFromBytes(bytes: Buffer, sheet: string | null | undefined, maxRows: number): SheetTable {
  // 按内容嗅探（与 open_workbook_auto 同口径）：zip → mimetype 判 ODS，其余交给 SheetJS；
  // OLE2 复合文档（.xls / .xlt）走 SheetJS；垃圾字节直接拒绝，不让 SheetJS 退化成 CSV 解析。
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const mimetype = zipReadEntry(bytes, "mimetype");
    if (mimetype !== null && mimetype.toString("utf8").includes("opendocument.spreadsheet")) {
      const content = zipReadEntry(bytes, "content.xml");
      if (content === null) throw new Error("ODS 文件缺少 content.xml");
      const parsed = parseOdsContent(content.toString("utf8"));
      const sheets = parsed.map((entry) => entry.name);
      if (sheets.length === 0) throw new Error("文件里没有工作表");
      const name = sheet !== null && sheet !== undefined && sheets.includes(sheet) ? sheet : sheets[0];
      const chosen = parsed.find((entry) => entry.name === name) ?? parsed[0];
      const truncated = chosen.rows.length > maxRows || chosen.rows.some((row) => row.length > MAX_COLS);
      const rows = chosen.rows.slice(0, maxRows).map((row) => row.slice(0, MAX_COLS));
      return { sheets, name, rows, truncated };
    }
    try {
      return readSheetFromWorkbookBytes(bytes, sheet, maxRows);
    } catch (error) {
      throw new Error(`无法识别表格格式：${(error as Error).message}`, { cause: error });
    }
  }
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    try {
      return readSheetFromWorkbookBytes(bytes, sheet, maxRows);
    } catch (error) {
      throw new Error(`无法识别表格格式：${(error as Error).message}`, { cause: error });
    }
  }
  throw new Error("无法识别表格格式：不是 zip 容器也不是 OLE2 复合文档");
}

/** 读取表格文件（`.xls` 等老格式），返回归一化后的字符串网格。走与 `fs_read_binary` 同一套路径授权。 */
export function readSheet(resolveExisting: (raw: string) => string, args: ReadSheetArgs): SheetTable {
  const path = resolveExisting(args.path);
  let size: number;
  let bytes: Buffer;
  try {
    size = statSync(path).size;
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`读取文件失败: ${(error as Error).message}`, { cause: error });
  }
  if (size > MAX_SHEET_BYTES) throw new Error("文件超过 20MB 上限");
  // 上限只收紧不放大：调用方给的值再大也不能突破 MAX_ROWS。
  const limit = Math.min(args.maxRows ?? MAX_ROWS, MAX_ROWS);
  return readSheetFromBytes(bytes, args.sheet ?? null, limit);
}
