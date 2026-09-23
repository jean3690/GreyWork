/**
 * PDF 查看器的缩放档位与页码收敛（纯逻辑，便于单测）。
 *
 * 缩放的语义：`1` = 「适应宽度」，也就是每页按容器宽度算出的那个基准缩放
 * （见 PdfViewer 的 `fitScaleOf`）。放大缩小都是在这个基准上乘一个倍率，
 * 所以窗口拉宽拉窄时「适应宽度」这一档永远是对的。
 */
export const PDF_MIN_ZOOM = 0.25;
export const PDF_MAX_ZOOM = 4;
export const PDF_ZOOM_STEP = 1.25;

/** 收敛到 [MIN, MAX]；非有限值（输入框给空串等）回落到 1（适应宽度）。 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, value));
}

/** 上下调一档。 */
export function zoomBy(current: number, direction: 1 | -1): number {
  return clampZoom(current * (direction === 1 ? PDF_ZOOM_STEP : 1 / PDF_ZOOM_STEP));
}

/** 页码收敛到 [1, total]；`total` 未知（0，文档还没解析出来）时至少给 1。 */
export function clampPage(page: number, total: number): number {
  const max = total > 0 ? total : 1;
  if (!Number.isFinite(page)) return 1;
  return Math.min(max, Math.max(1, Math.round(page)));
}
