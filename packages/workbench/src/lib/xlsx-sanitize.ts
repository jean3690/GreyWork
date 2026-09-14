/**
 * xlsx 读前清洗：剥离图纸 / 图表 / 媒体部件。
 *
 * 为什么要剥：exceljs 有两个入口 —— node 走 `lib/`(源码,补丁有效),
 * 浏览器 / webview 走 `browser` 字段指向的 `dist/exceljs.min.js`(预打包产物,
 * 改不动)。而 dist 解析 drawing 部件时按 `xdr:` 字面前缀匹配节点名,
 * openpyxl 等写入器用默认命名空间(`<wsDr xmlns="...">`),解析不出内容,
 * reconcile 阶段 `drawing.anchors` 就崩在 undefined 上(界面表现为
 * 「无法渲染该表格: undefined is not an object (evaluating 'r4.anchors')」)。
 *
 * 预览链路本来就只消费单元格(值/样式/合并/尺寸),图纸图表媒体一律不渲染;
 * 与其和 exceljs 的解析缺陷缠斗,不如在喂给它之前把这几类部件连同
 * worksheet 关系里的指向一起拿掉。
 *
 * 只拿掉部件和关系还不够:sheet xml 里的 `<drawing r:id="rId1"/>` 必须一并摘掉。
 * exceljs 的 worksheet reconcile 是 `rels[model.drawing.rId].Target.match(...)` ——
 * 关系没了这行就崩在 `.Target` 上,关系还在(部件已剥)就崩在 `.anchors` 上,
 * 两条路都走不通,只有 `model.drawing` 为空才会整块跳过。
 * 没有命中时原样返回原 buffer,自己的写入器产物(无图纸)零开销。
 */
import type JSZip from "jszip";

/** 这些目录里的部件是 exceljs 图纸解析的输入,预览用不到。 */
const GRAPHICS_PART = /^xl\/(drawings|charts|media)\//;
/** worksheet rels 里指向图纸/图表/媒体的 Relationship:按 Target 与 Type 双保险识别。 */
const GRAPHICS_REL_TARGET = /\/(drawings|charts|media)\//;
const GRAPHICS_REL_TYPE = /\/(drawing|chart|image)$/;
/** worksheet:剥掉指向图纸的引用本身(自闭合或成对写法都要认)。 */
const WORKSHEET_XML = /^xl\/worksheets\/[^/]+\.xml$/;
const DRAWING_REF = /\s*<drawing\b[^>]*?(?:\/>|>\s*<\/drawing>)/g;

/**
 * 去掉一个 worksheet rels 文件里指向图纸/图表/媒体的 Relationship 条目,
 * 其余(超链接 / 表格 / 批注)原样保留。rels 都是单行自闭合元素,
 * 属性值里不会有 '>',按元素整体匹配是安全的。
 */
function stripGraphicsRels(xml: string): string {
  let changed = false;
  const cleaned = xml.replace(/\s*<Relationship\b[^>]*?\/>/g, (element) => {
    const type = /Type="([^"]*)"/.exec(element)?.[1] ?? "";
    const target = /Target="([^"]*)"/.exec(element)?.[1] ?? "";
    const isGraphics = GRAPHICS_REL_TYPE.test(type) || GRAPHICS_REL_TARGET.test(target);
    if (isGraphics) {
      changed = true;
      return "";
    }
    return element;
  });
  return changed ? cleaned.replace(/>\s+</g, "><") : xml;
}

/** 原 buffer 的独立视图(不复制内容)。 */
function viewOf(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * 这份 xlsx 里是否含图纸 / 图表 / 媒体部件。
 *
 * 供预览内编辑的「保存」前告警：exceljs 的 load→writeBuffer 循环不会把这几类部件写回，
 * 一份带图表的工作簿在预览里改一格再保存，图表就没了 —— 与其静默丢掉，不如提前说清。
 * 只扫条目名，不重新打包。
 */
export async function hasGraphicsParts(data: Uint8Array): Promise<boolean> {
  const { default: JSZip } = await import("jszip");
  try {
    const zip = await JSZip.loadAsync(data);
    return Object.values(zip.files).some((entry) => !entry.dir && GRAPHICS_PART.test(entry.name));
  } catch {
    // 不是合法 zip：由后续 exceljs 报错，这里不抢语义
    return false;
  }
}

/**
 * 剥掉 xlsx 里的图纸/图表/媒体部件,返回可直接交给 exceljs 的 buffer。
 * 无命中(或不是合法 zip)时原样返回,不让这里的失败替换 exceljs 的报错语义。
 */
export async function sanitizeXlsxGraphics(data: Uint8Array): Promise<ArrayBuffer> {
  // jszip 只在真正要剥图纸时才有用：静态 import 会把它带进任何静态引用本模块的
  // chunk（会话 store 链直达入口），而多数 xlsx（自己的写入器产物）根本不用剥。
  const { default: JSZip } = await import("jszip");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return viewOf(data);
  }

  let touched = false;
  const output = new JSZip();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const name = entry.name;
    if (GRAPHICS_PART.test(name)) {
      touched = true; // 部件连同其 _rels 一起剥掉
      continue;
    }
    // 只对文本部件解码:二进制部件(vbaProject / 缩略图等)按字符串读会当场毁掉
    const isRels = name.startsWith("xl/worksheets/_rels/") && name.endsWith(".rels");
    const isSheetXml = WORKSHEET_XML.test(name);
    let content: string | Uint8Array | null = null;
    if (isRels || isSheetXml) {
      const xml = await entry.async("string");
      const cleaned = isRels ? stripGraphicsRels(xml) : xml.replace(DRAWING_REF, "");
      if (cleaned !== xml) {
        touched = true;
        content = cleaned;
      }
    }
    output.file(name, content ?? (await entry.async("uint8array")));
  }

  return touched ? output.generateAsync({ type: "arraybuffer" }) : viewOf(data);
}
