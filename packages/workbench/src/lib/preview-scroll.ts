/**
 * 预览滚动位置备忘：切 tab / 切到文件区都会销毁重建 viewer，滚动位置随之清零。
 *
 * 两种机制，因为「内容什么时候存在」不一样：
 *
 * - **DOM 类 viewer**（docx / md / diff / web / slide / csv / code / 图片）一次性渲染出
 *   可滚的容器，存像素偏移即可。由 PreviewSurface 统一存取，靠 `data-scroll-root`
 *   契约找到滚动容器（与 `data-selection-scope` 同一思路，不用逐个 viewer 写代码）。
 * - **PDF 例外**：内容是渐进渲染的 —— 只存像素偏移的话，在把内容补齐之前那个位置
 *   根本滚不到。所以存「已渲染页数 + 像素偏移」，恢复时先重渲染到那一页再滚过去
 *   （PdfViewer 自己做，不走 `data-scroll-root` 这条通用路）。
 *
 * 键是 tab id：tab 关掉重开会拿到新 id，旧条目天然作废；上限只是防一个长会话把 Map 撑大。
 */

const PIXEL_SCROLL = new Map<string, number>();
const PDF_PROGRESS = new Map<string, { pages: number; top: number }>();

const MAX_ENTRIES = 100;

/** 满了丢最旧的（Map 迭代序即插入序）。 */
function evictIfNeeded(map: Map<string, unknown>): void {
  if (map.size < MAX_ENTRIES) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/** 记一个 DOM 滚动容器的像素偏移。0 也记 —— 「滚回顶部」是有效状态，不记就会还原成旧位置。 */
export function rememberPixelScroll(key: string, top: number): void {
  if (!Number.isFinite(top) || top < 0) return;
  evictIfNeeded(PIXEL_SCROLL);
  PIXEL_SCROLL.set(key, top);
}

/** 取回像素偏移；没记过返回 null（调用方就不必动滚动条）。 */
export function recallPixelScroll(key: string): number | null {
  const top = PIXEL_SCROLL.get(key);
  return typeof top === "number" && top >= 0 ? top : null;
}

export interface PdfScrollProgress {
  /** 已渲染到的页数（含），恢复时重渲染到这个数。 */
  pages: number;
  /** 像素偏移，页数补齐之后再套用。 */
  top: number;
}

export function rememberPdfProgress(key: string, progress: PdfScrollProgress): void {
  if (!Number.isFinite(progress.top) || progress.top < 0 || progress.pages <= 0) return;
  evictIfNeeded(PDF_PROGRESS);
  PDF_PROGRESS.set(key, { pages: Math.floor(progress.pages), top: progress.top });
}

export function recallPdfProgress(key: string): PdfScrollProgress | null {
  const progress = PDF_PROGRESS.get(key);
  if (!progress || progress.pages <= 0) return null;
  return { pages: progress.pages, top: progress.top };
}
