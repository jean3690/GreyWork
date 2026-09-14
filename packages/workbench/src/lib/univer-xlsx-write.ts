/**
 * Univer 表格编辑 → xlsx 回写。
 *
 * **为什么是「原始字节 + 定点改写」而不是「快照 → 全量导出」**：
 * `lib/univer-xlsx.ts` 的读入方向只取公式的**缓存结果**（预览不重算），快照里没有公式本身。
 * 整表重建会把原文件里所有没被动过的公式变成静态值 —— 比不保存还糟。反过来，
 * 只把「用户真正改动过的单元格」写进原始工作簿，未被触碰的公式、样式、主题色全部原样留着。
 *
 * **为什么只写 value 而不碰 `cell.font/fill/...`**：exceljs 赋 value 不清样式，
 * 所以哪怕一格是「改了个数字」，它的字体/底色（包括转换器读不出的主题色）也不会被抹掉。
 *
 * 明确**不做**（Univer 侧改了也不落盘，SheetViewer 上有文案说明）：
 * 样式 / 数字格式、合并区、行列尺寸、增删工作表、单元格富文本（`p`）。
 * 另：exceljs 的 load→writeBuffer 循环写不回图纸/图表/媒体部件（读入前已被
 * `sanitizeXlsxGraphics` 剥掉），保存前由 `hasGraphicsParts` 告警，见 SheetViewer。
 */
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import type { Workbook, Worksheet } from "exceljs";
import { sanitizeXlsxGraphics } from "./xlsx-sanitize";
import { sanitizeSheetName } from "./xlsx";

/** `sheet-<n>` —— `univer-xlsx.ts` 拿 exceljs 的 sheet id 当快照里的工作表 id。 */
const SHEET_ID = /^sheet-(\d+)$/;

/** 值比较用的平铺表：`"行:列"` → 单元格。 */
type CellTable = Map<string, ICellData>;

function toCellTable(cellData: IWorksheetData["cellData"] | undefined): CellTable {
  const table: CellTable = new Map();
  if (!cellData) return table;
  // 快照的对象键在运行时是字符串，类型却声明成 number —— 按字符串键遍历，不做无谓的 Number 转换。
  const rows = cellData as unknown as Record<string, Record<string, ICellData> | undefined>;
  for (const [row, line] of Object.entries(rows)) {
    if (!line) continue;
    for (const [col, cell] of Object.entries(line)) {
      if (cell) table.set(`${row}:${col}`, cell);
    }
  }
  return table;
}

/**
 * 单元格**内容**是否等价：只比 `v`（值）与 `f`（公式），不比样式。
 * 样式差异不参与判定 —— 样式本来就不落盘，把它算进 diff 只会让保存写出等价内容。
 */
function sameContent(before: ICellData | undefined, after: ICellData | undefined): boolean {
  return (before?.v ?? undefined) === (after?.v ?? undefined) && (before?.f ?? undefined) === (after?.f ?? undefined);
}

/** 写回一格：空内容判为清空，有公式写成公式，其余按标量。 */
function writeCell(sheet: Worksheet, row: number, col: number, cell: ICellData | undefined): void {
  const target = sheet.getCell(row + 1, col + 1);
  const value = cell?.v ?? null;
  if (!cell || (value === null && !cell.f)) {
    target.value = null;
    return;
  }
  if (cell.f) {
    // exceljs 的公式值可带缓存结果；没有结果时**整个省略 result**，
    // 写 null 会产出 `<v></v>` 这种 Excel 判为损坏的单元格。缺结果时 Excel 会自己重算。
    target.value = (value === null ? { formula: cell.f } : { formula: cell.f, result: value }) as never;
    return;
  }
  // 非标量（异常输入）退回字符串，避免 exceljs 拿到对象后写出畸形单元格。
  const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : String(value);
  target.value = scalar as never;
}

/**
 * 按 id 定位 exceljs 工作表。
 *
 * `sheet-N` 直接取第 N 个 —— `Workbook.getWorksheet(number)` 就是查 `_worksheets[id]`，
 * 而 `eachSheet` 回传的正是 `sheet.id`，两边同源。Univer 里新加的工作表拿不到这种 id，
 * 退回按名查，没有就新建。
 */
function resolveSheet(workbook: Workbook, id: string, name: string | undefined): Worksheet | null {
  const index = SHEET_ID.exec(id)?.[1];
  if (index) {
    const existing = workbook.getWorksheet(Number(index));
    if (existing) return existing;
  }
  const label = sanitizeSheetName(name ?? "Sheet");
  return workbook.getWorksheet(label) ?? workbook.addWorksheet(label);
}

/** 把 base → current 的内容差异写进对应工作表。before 缺失即「新工作表」，整表写入。 */
function applySheet(sheet: Worksheet, before: Partial<IWorksheetData> | undefined, after: Partial<IWorksheetData>): void {
  const beforeCells = toCellTable(before?.cellData);
  const afterCells = toCellTable(after.cellData);
  for (const key of new Set([...beforeCells.keys(), ...afterCells.keys()])) {
    const previous = beforeCells.get(key);
    const next = afterCells.get(key);
    if (sameContent(previous, next)) continue;
    const [row, col] = key.split(":");
    writeCell(sheet, Number(row), Number(col), next);
  }
}

/**
 * 把 Univer 快照相对基准快照的内容改动写回原始 xlsx 字节，返回新字节。
 *
 * `base` 必须是 `createUnit` 之后**立刻**取的 `getSnapshot()` —— Univer 建单元时会规范化
 * （补行列数、重排样式 id、丢空单元格），拿转换器的输出当基准会对不上，diff 全是噪音。
 */
export async function applyUniverEdits(original: Uint8Array, base: IWorkbookData, current: IWorkbookData): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await sanitizeXlsxGraphics(original));

  for (const sheetId of current.sheetOrder) {
    const after = current.sheets[sheetId];
    if (!after) continue;
    const before = base.sheets[sheetId];
    const sheet = resolveSheet(workbook, sheetId, after.name);
    if (!sheet) continue;
    // 新工作表已按 current 的名建好，只有既存表改名才需要动
    if (before && after.name && before.name !== after.name) sheet.name = sanitizeSheetName(after.name);
    applySheet(sheet, before, after);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
