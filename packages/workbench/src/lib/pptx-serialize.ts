/**
 * pptx 就地文本回写：只改指定 slideN.xml 里命中的 a:t 文字，其余字节原样保留。
 *
 * 与 docx 同理（见 docx-serialize）：`pptx-parse` 是有损显示模型，重序列化会丢版式/母版/主题/
 * 动画/媒体。就地补丁把原 zip 解开、只替换命中的 a:t，原样打包 —— 结构与未触碰部件零损失。
 *
 * 定位锚是 `${slide}:${ord}`：slide 为 1 基页号（slidePaths 顺序），ord 为该 a:t 在本页的文档序。
 * 页号→路径与 a:t 编号都复用 `pptx-parse` 的 `slidePathsOf` / `forEachSlideTextNode`，两端必然一致。
 */
import JSZip from "jszip";
import { forEachSlideTextNode, slidePathsOf } from "./pptx-parse";

/** 按 `${slide}:${ord}` 回写文本，返回新 pptx 字节。 */
export async function patchPptxText(original: Uint8Array, edits: ReadonlyMap<string, string>): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(original);
  if (edits.size === 0) return original;
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    throw new Error("当前环境缺少 DOMParser / XMLSerializer，无法回写 pptx");
  }

  // 先按页分组：每页只解析、序列化一次。
  const bySlide = new Map<number, Map<number, string>>();
  for (const [key, text] of edits) {
    const colon = key.indexOf(":");
    const slide = Number(key.slice(0, colon));
    const ord = Number(key.slice(colon + 1));
    let ordMap = bySlide.get(slide);
    if (!ordMap) {
      ordMap = new Map();
      bySlide.set(slide, ordMap);
    }
    ordMap.set(ord, text);
  }

  const paths = await slidePathsOf(zip);
  for (const [slide, ordMap] of bySlide) {
    const path = paths[slide - 1];
    const file = path ? zip.file(path) : null;
    if (!file) continue;
    const doc = new DOMParser().parseFromString(await file.async("string"), "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) throw new Error(`${path} 解析失败`);
    forEachSlideTextNode(doc.documentElement, (el, ord) => {
      const next = ordMap.get(ord);
      if (next !== undefined) el.textContent = next;
    });
    zip.file(path, new XMLSerializer().serializeToString(doc));
  }

  return zip.generateAsync({ type: "uint8array" });
}
