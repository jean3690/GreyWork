/** 产物查看器的类型分派与文件名工具（纯逻辑，便于单测）。 */

export type ViewerKind = "md" | "html" | "csv" | "xlsx" | "docx" | "pptx" | "raw";

const EXT_KIND: Record<string, ViewerKind> = {
  md: "md",
  markdown: "md",
  html: "html",
  htm: "html",
  csv: "csv",
  xlsx: "xlsx",
  xls: "xlsx",
  docx: "docx",
  pptx: "pptx",
};

/** 按扩展名推断产物查看类型；未知归 raw（文本兜底）。 */
export function kindOfPath(path: string): ViewerKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? "raw";
}

/** 取路径末段文件名。 */
export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
