/**
 * docx 就地文本回写：只改 word/document.xml 里指定 w:t 的文字，其余字节原样保留。
 *
 * **为什么就地补丁而不是从显示模型重序列化**：`docx-parse` 产出的是有损显示模型（页眉页脚、
 * styles.xml、编号、域、嵌入对象等一概没进模型）。从它重建 document.xml 会把这些全丢掉。
 * 就地补丁把原 zip 解开、只替换命中 w:t 的文本节点、原样打包 —— 结构与所有未触碰部件零损失。
 *
 * 定位锚是 w:t 的文档序序号，与 `docx-parse` 解析时的编号同源（都走 `forEachDocumentTextNode`），
 * 只要喂的是同一份 document.xml，两端序号必然一致。
 */
import JSZip from "jszip";
import { forEachDocumentTextNode } from "./docx-parse";

const DOCUMENT_PATH = "word/document.xml";

/** 按 w:t 序号回写文本，返回新 docx 字节。`edits`：w:t 序号 → 新文本。 */
export async function patchDocxText(original: Uint8Array, edits: ReadonlyMap<number, string>): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(original);
  const file = zip.file(DOCUMENT_PATH);
  if (!file) throw new Error("docx 缺少 word/document.xml");
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    throw new Error("当前环境缺少 DOMParser / XMLSerializer，无法回写 docx");
  }

  const doc = new DOMParser().parseFromString(await file.async("string"), "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("word/document.xml 解析失败");

  forEachDocumentTextNode(doc.documentElement, (el, ordinal) => {
    const next = edits.get(ordinal);
    if (next === undefined) return;
    el.textContent = next;
    // 首尾空白必须显式保留，否则 Word 会按默认折叠掉（xml:space 的 xml 前缀是预定义命名空间）。
    if (/^\s|\s$/.test(next)) el.setAttribute("xml:space", "preserve");
  });

  zip.file(DOCUMENT_PATH, new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: "uint8array" });
}
