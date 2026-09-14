/**
 * PDF 文本层：把 `getTextContent()` 的文字按视口坐标摆成可选的 span。
 *
 * **为什么不用 pdf.js 自带的 `TextLayer`**：它是为 pdf.js 自家 viewer 设计的，
 * 依赖三层脚手架 —— `.textLayer` 的 CSS 规则（在 800 行的 `pdf_viewer.css` 里）、
 * 由 viewer 应用设置的 `--total-scale-factor`（pdf.js 自己从不设它）、以及
 * `--scale-round-x/y` + CSS `round()`。第三项在 WebKitGTK 上不保证支持，而本项目主要在
 * Linux 上开发；且它内部把几何量按 `viewport.scale * devicePixelRatio` 算，与这里
 * 「canvas 按 dpr 绘制、按逻辑尺寸显示」的约定也对不上。自己摆 span 约七十行，
 * 坐标关系完全可控。
 *
 * 纯数学部分（矩阵、布局、拉伸比）与 DOM 部分分开：量宽靠外部注入，
 * 因为 happy-dom 的 `getContext("2d")` 返回 null，注入才测得到。
 *
 * **已知限制**：这里不加载 PDF 内嵌字体，量宽只能用回退字体，所以 `scaleX` 是近似值 ——
 * 它保证每个 span 占据正确的总宽度（消除逐段累积的横向偏移），但不保证 span 内部
 * 每个字形都与 canvas 上的墨迹严格对齐。未嵌入字体的文档尤其明显。
 */

/** 文本项的基线到顶边比例。取不到字体度量时用 0.8（pdf.js 的默认值也是这个量级）。 */
export const DEFAULT_ASCENT = 0.8;

export interface PdfTextItemLike {
  str?: string;
  /** 文本宽度（文本空间单位）。 */
  width?: number;
  /** 文本空间 → PDF 用户空间的矩阵 [a,b,c,d,e,f]。 */
  transform?: number[];
  /**
   * 标记内容项（`beginMarkedContent` 之类）带这个字段且没有 `str`。
   * 声明出来是为了如实描述 `getTextContent()` 的联合形状，而不是为了用它。
   */
  type?: string;
}

export interface TextPieceLayout {
  text: string;
  /** 视口坐标（CSS px）下 span 的左上角。 */
  left: number;
  top: number;
  fontSize: number;
  /** 旋转角（弧度）；0 表示水平。 */
  angle: number;
  /** 这一项应当占据的宽度（CSS px），用于算拉伸比。 */
  targetWidth: number;
}

/** pdf.js `Util.transform` 的等价实现：m1 × m2。 */
export function multiplyMatrix(m1: readonly number[], m2: readonly number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** 视口矩阵里的缩放系数（旋转视口下也成立）。 */
function scaleOf(viewportTransform: readonly number[]): number {
  return Math.hypot(viewportTransform[0], viewportTransform[1]);
}

/**
 * 单个文本项 → 布局。返回 null 表示这一项不产生可见文字（空串、标记项、零字号）。
 */
export function layoutTextItem(
  item: PdfTextItemLike,
  viewportTransform: readonly number[],
  ascent: number = DEFAULT_ASCENT,
): TextPieceLayout | null {
  const text = item.str;
  if (!text || !item.transform || item.transform.length < 6) return null;

  const matrix = multiplyMatrix(viewportTransform, item.transform);
  const fontSize = Math.hypot(matrix[2], matrix[3]);
  if (!Number.isFinite(fontSize) || fontSize <= 0) return null;

  const angle = Math.atan2(matrix[1], matrix[0]);
  const offset = ascent * fontSize;
  // 矩阵的 e/f 是基线原点；span 的 top 要的是顶边，按 ascent 往上让。
  // 有旋转时让的方向也跟着转，否则斜排文字会整体偏出去。
  const left = angle === 0 ? matrix[4] : matrix[4] + offset * Math.sin(angle);
  const top = angle === 0 ? matrix[5] - offset : matrix[5] - offset * Math.cos(angle);

  const targetWidth = (item.width ?? 0) * scaleOf(viewportTransform);

  return { text, left, top, fontSize, angle, targetWidth };
}

export function layoutTextItems(
  items: readonly PdfTextItemLike[],
  viewportTransform: readonly number[],
  ascent: number = DEFAULT_ASCENT,
): TextPieceLayout[] {
  const pieces: TextPieceLayout[] = [];
  for (const item of items) {
    const piece = layoutTextItem(item, viewportTransform, ascent);
    if (piece) pieces.push(piece);
  }
  return pieces;
}

/**
 * 拉伸比。量不到宽度（没有 2d 上下文）或宽度不合理时返回 1 ——
 * 宁可不拉伸，也不要按一个坏比值把文字拉成一条线。
 */
export function computeStretch(targetWidth: number, measuredWidth: number): number {
  if (!(measuredWidth > 0) || !(targetWidth > 0)) return 1;
  return targetWidth / measuredWidth;
}

export type MeasureText = (text: string, fontSize: number) => number;

/**
 * 把布局摆成 span，塞进给定的容器。
 *
 * span 上的 `transform` 同时承担旋转与横向拉伸：`scaleX` 在前、`rotate` 在后，
 * 配合 CSS 的 `transform-origin: 0 0` 就是 pdf.js 那套 `--scale-x` / `--rotate` 的效果。
 */
export function buildTextLayer(layer: HTMLElement, pieces: readonly TextPieceLayout[], measure: MeasureText): void {
  const fragment = document.createDocumentFragment();
  for (const piece of pieces) {
    const span = document.createElement("span");
    span.textContent = piece.text;
    span.style.left = `${piece.left}px`;
    span.style.top = `${piece.top}px`;
    span.style.fontSize = `${piece.fontSize}px`;

    const transforms: string[] = [];
    if (piece.angle !== 0) transforms.push(`rotate(${piece.angle}rad)`);
    const stretch = computeStretch(piece.targetWidth, measure(piece.text, piece.fontSize));
    if (stretch !== 1) transforms.push(`scaleX(${stretch})`);
    if (transforms.length > 0) span.style.transform = transforms.join(" ");

    fragment.appendChild(span);
  }
  layer.replaceChildren(fragment);
}
