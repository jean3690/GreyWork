/**
 * exceljs 单元格复合值 → 归一化标量（Univer 渲染与可编辑矩阵共用同一份语义）。
 *
 * 日期的表达交给调用方注入，因为两处消费方要求相反：Univer 要 Excel 序列号
 * （必须是数字，配上数字格式才能渲染成日期），内联文字网格要人读得出的字符串。
 * 除日期外的形态拆解只此一份 —— 此前 univer-xlsx 自己留了一副本，结果富文本、
 * 错误值在 Univer 里是对的，在文字矩阵里仍落到 `[object Object]`。
 */
import { isRecord } from "./guards";

export type CellValue = string | number | boolean;

/**
 * exceljs 的 cell.value 有七种形态，逐一拆解；`undefined` 表示空单元格。
 * `dateAs` 作用于日期本身，也作用于公式结果里的日期。
 */
export function normalizeCellValue(value: unknown, dateAs: (date: Date) => CellValue): CellValue | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return dateAs(value);
  if (!isRecord(value)) return String(value);

  // 公式 / 共享公式：取缓存结果（预览不重算），结果本身可能又是错误值或日期
  if ("result" in value) return normalizeCellValue(value.result, dateAs);
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

/** exceljs 复合值 → 展示字符串（空单元格为空串）。 */
export function cellDisplayValue(value: unknown): string {
  const normalized = normalizeCellValue(value, (date) => date.toISOString());
  return normalized === undefined ? "" : String(normalized);
}
