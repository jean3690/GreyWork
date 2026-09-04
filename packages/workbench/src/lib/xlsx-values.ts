/**
 * exceljs 单元格复合值 → 展示归一化（Univer 渲染与可编辑矩阵共用同一份语义）。
 * 此前 univer-xlsx 的 toCellValue 与 artifact-edit 的 cellDisplayValue 是两份
 * 逐位重复的实现，仅返回值宽度不同（原始值 vs 字符串）。
 */

export type CellValue = string | number | boolean;

/** exceljs 复合值 → 原始标量（undefined = 空单元格）。 */
export function toCellValue(value: unknown): CellValue | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.formula !== undefined) {
      const result = record.result;
      if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") return result;
    }
    return String(value);
  }
  return String(value);
}

/** exceljs 复合值 → 展示字符串（空单元格为空串）。 */
export function cellDisplayValue(value: unknown): string {
  const normalized = toCellValue(value);
  if (normalized === undefined) return "";
  return String(normalized);
}
