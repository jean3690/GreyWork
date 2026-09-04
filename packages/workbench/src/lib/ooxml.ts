/**
 * OOXML（docx / pptx / xlsx 共用）解析底座：DOM 遍历、包内关系表、图片解码、单位换算。
 *
 * 抽出来的理由：pptx 与 docx 的解析各自都要绕开同一批坑（带前缀的标签与属性、`r:embed`
 * 这类关系引用、`../media/x.png` 的相对路径、图片转 data URL）。这些坑写两遍就会各修一半。
 * 格式特有的语义（形状几何、段落样式、单元格样式）留在各自的解析器里，这里只放公共机制。
 */
import type JSZip from "jszip";

/** 1 CSS px = 9525 EMU（914400 EMU/inch ÷ 96 px/inch）。 */
export const EMU_PER_PX = 9525;

/** 1 CSS px = 15 twip（1440 twip/inch ÷ 96 px/inch）；docx 的长度单位是 twip。 */
export const TWIP_PER_PX = 15;

/**
 * 取去掉命名空间前缀的标签名。
 *
 * 不用 localName / getElementsByTagNameNS：不同 XML 解析器（浏览器 DOMParser 与测试用的
 * happy-dom）对未声明命名空间感知时的 localName 行为不一致，而 nodeName 一定是「前缀:本名」，
 * 剥前缀是唯一在两边都成立的做法。也顺带兼容用其他前缀的生产者。
 */
export function local(node: Element): string {
  const name = node.nodeName;
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** 直接子元素中所有同名者。逐层取而非全树搜：避免把嵌套子节点的同名标签当成自己的。 */
export function kids(parent: Element | null, name: string): Element[] {
  if (!parent) return [];
  const out: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (local(child) === name) out.push(child);
  }
  return out;
}

export function kid(parent: Element | null, name: string): Element | null {
  if (!parent) return null;
  for (const child of Array.from(parent.children)) {
    if (local(child) === name) return child;
  }
  return null;
}

/** 沿路径逐层下钻，任一层缺失即 null。 */
export function pick(parent: Element | null, ...path: string[]): Element | null {
  let node = parent;
  for (const name of path) {
    node = kid(node, name);
    if (!node) return null;
  }
  return node;
}

/** 后代中所有同名者（深度优先，用于不关心层级的场合）。 */
export function deep(parent: Element | null, name: string, out: Element[] = []): Element[] {
  if (!parent) return out;
  for (const child of Array.from(parent.children)) {
    if (local(child) === name) out.push(child);
    deep(child, name, out);
  }
  return out;
}

export function attr(el: Element | null, name: string): string | null {
  return el?.getAttribute(name) ?? null;
}

/**
 * 取关系引用属性（`r:embed` / `r:id`），按本名匹配、**带前缀的优先**。
 *
 * 两个坑叠在一起：`getAttribute("embed")` 取不到带前缀的属性；而写死 `"r:embed"` 又赌了
 * 生产者一定用 `r` 作前缀。更要命的是 `<p:sldId id="256" r:id="rId3"/>` 两个都有 ——
 * 无前缀的 `id` 是页号，拿它去查关系表必然落空，所以顺序不能反。
 */
export function relAttr(el: Element | null, name: string): string | null {
  if (!el) return null;
  for (const item of Array.from(el.attributes)) {
    const colon = item.name.indexOf(":");
    if (colon !== -1 && item.name.slice(colon + 1) === name) return item.value;
  }
  return el.getAttribute(name);
}

/** OOXML 布尔属性可写 "1" / "true"，也可只写标签本身（缺 val 即为真）。 */
export function boolAttr(el: Element | null, name: string): boolean {
  const value = attr(el, name);
  return value === "1" || value === "true";
}

export function emuToPx(value: string | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? n / EMU_PER_PX : 0;
}

export function twipToPx(value: string | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? n / TWIP_PER_PX : 0;
}

export function parseXml(text: string): Element | null {
  if (typeof DOMParser === "undefined") throw new Error("当前环境没有 DOMParser，无法解析 OOXML");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc.documentElement ?? null;
}

/* ===== 包内关系与路径 ===== */

/** 解析 `../media/image1.png` 这类相对目标为包内绝对路径。 */
export function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = base.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

export interface Rels {
  /** rId → 包内绝对路径。 */
  byId: Map<string, string>;
  /** 关系类型末段（slideLayout / notesSlide / image / …）→ 包内绝对路径。 */
  byType: Map<string, string>;
}

export const EMPTY_RELS: Rels = { byId: new Map(), byType: new Map() };

export function parseRels(xml: string | null, ownerPath: string): Rels {
  const byId = new Map<string, string>();
  const byType = new Map<string, string>();
  const root = xml ? parseXml(xml) : null;
  for (const rel of kids(root, "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) continue;
    // 外部关系（超链接等）不是包内文件，取了会指向不存在的 zip 条目
    if (attr(rel, "TargetMode") === "External") continue;
    const path = resolvePath(ownerPath, target);
    byId.set(id, path);
    const type = (attr(rel, "Type") ?? "").split("/").pop() ?? "";
    if (type && !byType.has(type)) byType.set(type, path);
  }
  return { byId, byType };
}

/** `word/document.xml` → `word/_rels/document.xml.rels`。 */
export function relsPathOf(partPath: string): string {
  const at = partPath.lastIndexOf("/");
  return at === -1 ? `_rels/${partPath}.rels` : `${partPath.slice(0, at)}/_rels/${partPath.slice(at + 1)}.rels`;
}

export async function readText(zip: JSZip, path: string | undefined): Promise<string | null> {
  if (!path) return null;
  const file = zip.files[path];
  return file ? file.async("text") : null;
}

export async function readXml(zip: JSZip, path: string | undefined): Promise<Element | null> {
  const text = await readText(zip, path);
  return text ? parseXml(text) : null;
}

/** 读取某部件的关系表（缺失即空表，调用方不必判空）。 */
export async function readRels(zip: JSZip, partPath: string): Promise<Rels> {
  const xml = await readText(zip, relsPathOf(partPath));
  return xml ? parseRels(xml, partPath) : { byId: new Map(), byType: new Map() };
}

/* ===== 图片 ===== */

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * 把关系表里所有可渲染的图片解码为 data URL（rId → URL）。
 *
 * 只收白名单内的扩展名：emf / wmf 是 Windows 图元文件，浏览器渲染不了，
 * 塞进 <img> 只会得到一个碎图标 —— 不如不给，让调用方按「没有这张图」处理。
 */
export async function decodeImages(zip: JSZip, rels: Rels): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  for (const [id, path] of rels.byId) {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const mime = IMAGE_MIME[ext];
    const file = zip.files[path];
    if (!mime || !file) continue;
    images.set(id, `data:${mime};base64,${await file.async("base64")}`);
  }
  return images;
}
