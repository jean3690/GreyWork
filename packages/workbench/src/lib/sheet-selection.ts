/**
 * 表格选区 → 可注入对话的文本。
 *
 * **为什么整块逻辑都在这里而不是 `SheetViewer.vue` 里**：Univer 在 happy-dom 里跑不起来，
 * `SheetViewer` 因此没有组件测试（与其它 viewer 不同）。把「读哪些单元格、怎么拼文本」
 * 全部下沉到只依赖三个访问器的纯函数，才能真正被测到 —— 组件里只留接线。
 *
 * **为什么附带公式**：只给计算结果的表格对 agent 价值有限 —— 看到 `120` 无从判断这是
 * 常量还是汇总。值 + 公式一起给，模型才能回答「这个总数怎么来的 / 哪里算错了」。
 */

/** 我们真正用到的三个访问器；用最小接口而非 Univer 类型，便于用假对象单测。 */
export interface SheetLike {
  getName(): string;
  getCell(row: number, col: number): unknown;
  getCellRaw(row: number, col: number): unknown;
}

export interface RangeLike {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export interface SheetRangeSelection {
  /** 例如 `Sheet1!A1:C3`。 */
  label: string;
  sheetName: string;
  /** 行优先的单元格文本矩阵。 */
  rows: string[][];
  /** 选区超过上限、只取了其中一部分。 */
  truncated: boolean;
}

/**
 * 选区规模上限。
 *
 * 附件本身有 12 万字符的内联上限，但那是「事后截断」——先拼出一个几十万字符的字符串
 * 再砍掉，既浪费又会让截断点落在莫名其妙的半个单元格上。这里按行列提前收口，
 * 并在文本里明说被截断了（不静默）。
 */
export const MAX_SELECTION_CELLS = 2000;
export const MAX_SELECTION_COLUMNS = 100;

/** 0 起的列号 → 列名（0→A、25→Z、26→AA）。Excel 用的是双射进制，不是普通 26 进制。 */
export function columnLabel(index: number): string {
  let remaining = Math.max(0, Math.floor(index));
  let out = "";
  do {
    out = String.fromCharCode(65 + (remaining % 26)) + out;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return out;
}

/** 范围标签：单格为 `Sheet1!A1`，区域为 `Sheet1!A1:C3`。行列对外都是 1 起。 */
export function formatRangeLabel(sheetName: string, range: RangeLike): string {
  const start = `${columnLabel(range.startColumn)}${range.startRow + 1}`;
  const single = range.startRow === range.endRow && range.startColumn === range.endColumn;
  const end = `${columnLabel(range.endColumn)}${range.endRow + 1}`;
  return `${sheetName}!${single ? start : `${start}:${end}`}`;
}

function valueOf(cell: unknown): unknown {
  return (cell as { v?: unknown } | null | undefined)?.v;
}

function formulaOf(raw: unknown): string | null {
  const formula = (raw as { f?: string | null } | null | undefined)?.f;
  return typeof formula === "string" && formula ? formula : null;
}

/**
 * 单元格文本。
 *
 * 显示值优先（`getCell` 已过 numfmt 拦截器，日期/百分比是用户看到的那个样子）；
 * 拿不到显示值时退回原始值。有公式就附在括号里，避免「只有结果没有来历」。
 */
export function formatCellText(display: unknown, formula: string | null): string {
  const shown = display === null || display === undefined ? "" : String(display);
  if (!formula) return shown;
  return shown ? `${shown} (${formula})` : formula;
}

/** 按行列上限裁剪出实际要采集的范围，并报告是否发生了截断。 */
function clampRange(range: RangeLike): { rows: number; cols: number; truncated: boolean } {
  const sourceRows = Math.max(0, range.endRow - range.startRow + 1);
  const sourceCols = Math.max(0, range.endColumn - range.startColumn + 1);
  const cols = Math.min(sourceCols, MAX_SELECTION_COLUMNS);
  // 至少保留一行：极端情况下（选区比单列上限还宽）宁可给一行也不给空。
  const rows = Math.min(sourceRows, Math.max(1, Math.floor(MAX_SELECTION_CELLS / Math.max(1, cols))));
  return { rows, cols, truncated: rows < sourceRows || cols < sourceCols };
}

export function readRangeSelection(sheet: SheetLike, range: RangeLike): SheetRangeSelection {
  const sheetName = sheet.getName();
  const { rows: rowCount, cols: colCount, truncated } = clampRange(range);
  const rows: string[][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = range.startRow + rowIndex;
    const line: string[] = [];
    for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
      const col = range.startColumn + colIndex;
      const display = valueOf(sheet.getCell(row, col));
      const raw = sheet.getCellRaw(row, col);
      line.push(formatCellText(display ?? valueOf(raw), formulaOf(raw)));
    }
    rows.push(line);
  }

  return { label: formatRangeLabel(sheetName, range), sheetName, rows, truncated };
}

/**
 * 拼成 TSV。
 *
 * 用制表符而不是 markdown 表格：附件的正文最终会被 `inlineTextAttachment` 包进代码围栏，
 * markdown 表格在围栏里只会原样显示；而 TSV 既能被模型直接读懂，也能原样粘回表格里。
 * 位置信息由标签给（写在附件的来源行上），所以这里不再重复列头行。
 */
export function formatSelectionTsv(selection: SheetRangeSelection): string {
  const body = selection.rows.map((row) => row.join("\t")).join("\n");
  if (!selection.truncated) return body;
  return `${body}\n[选区过大，仅包含前 ${selection.rows.length} 行 × ${selection.rows[0]?.length ?? 0} 列]`;
}
