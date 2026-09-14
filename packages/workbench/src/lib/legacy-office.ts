/**
 * 老格式 Office 文件的容器嗅探。
 *
 * 只回答一件事：一个 .doc / .xls / .ppt 到底是 OLE2 复合文档（真·老格式，现有解析器读不了），
 * 还是被改错了扩展名的 OOXML（其实是 docx/xlsx/pptx，现有解析器能读）。
 * 后者在真实文件里并不罕见 —— 导出工具写错后缀、邮件网关改写扩展名都会造成。
 * 认出来就能给一句可操作的提示，而不是笼统地说「不支持」。
 *
 * 纯逻辑、零依赖：喂文件头若干字节，返回结论，便于单测。
 */

export type OfficeContainer =
  | { kind: "ole2" }
  | { kind: "ooxml"; format: "docx" | "xlsx" | "pptx" }
  | { kind: "zip" }
  | { kind: "unknown" };

const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** 普通本地文件头 / 空归档 / 分卷归档。三种都算 ZIP。 */
const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];

/**
 * ZIP 的本地文件头里条目名是**不压缩**存放的，所以这几个固定路径能直接在字节流里找到。
 * 比解压 [Content_Types].xml 便宜得多，也免得为一次嗅探拉起 jszip。
 */
const OOXML_MARKERS: ReadonlyArray<readonly [string, "docx" | "xlsx" | "pptx"]> = [
  ["word/document.xml", "docx"],
  ["xl/workbook.xml", "xlsx"],
  ["ppt/presentation.xml", "pptx"],
];

/** 扫描窗口：本地文件头集中在文件开头，8 KiB 足够，不必扫整个文件。 */
const SCAN_BYTES = 8 * 1024;

function matchesAt(bytes: Uint8Array, signature: readonly number[], offset: number): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** 窗口内按 latin1 解串找 ASCII 条目名 —— 逐字节映射，不会像 TextDecoder 那样替换掉高位字节。 */
function asciiWindow(bytes: Uint8Array): string {
  const end = Math.min(bytes.length, SCAN_BYTES);
  let out = "";
  for (let index = 0; index < end; index += 1) out += String.fromCharCode(bytes[index]);
  return out;
}

export function sniffOfficeContainer(bytes: Uint8Array): OfficeContainer {
  if (bytes.length === 0) return { kind: "unknown" };
  if (matchesAt(bytes, OLE2_SIGNATURE, 0)) return { kind: "ole2" };
  if (!ZIP_SIGNATURES.some((signature) => matchesAt(bytes, signature, 0))) return { kind: "unknown" };

  const window = asciiWindow(bytes);
  for (const [marker, format] of OOXML_MARKERS) {
    if (window.includes(marker)) return { kind: "ooxml", format };
  }
  return { kind: "zip" };
}
