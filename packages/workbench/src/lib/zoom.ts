/**
 * 预览器缩放的共享手感参数（纯逻辑，便于单测）。
 *
 * 三类输入要落在同一条曲线上：
 * - 鼠标滚轮：一格 `deltaY` ≈ 100（像素模式）；
 * - 触控板双指滑动：每次只有几像素，但一秒几十次；
 * - 触控板捏合：浏览器以 `ctrl + wheel` 的形式送来，delta 很小。
 *
 * 所以用指数而不是「每个事件乘固定倍率」：固定倍率在触控板上会一帧一档，
 * 手指刚动就飞到底。指数保证「累计位移相同 → 缩放相同」，与事件频率无关。
 */

/** 滚轮每像素的缩放增益：一格 100px ≈ 1.22 倍。 */
export const WHEEL_ZOOM_GAIN = 0.002;
/** 捏合的 delta 比滚轮小一个数量级，需要单独放大增益。 */
export const PINCH_ZOOM_GAIN = 0.01;
/** 单次事件最多缩放到 2× / 0.5×，兜住滚轮加速、远程桌面等异常 delta。 */
export const WHEEL_FACTOR_MIN = 0.5;
export const WHEEL_FACTOR_MAX = 2;

/** 行 / 页模式的增量折算成像素（Firefox 与部分远程桌面会给非像素模式）。 */
function scaleDelta(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 400;
  return delta;
}

export function wheelDeltaX(event: { deltaX: number; deltaMode: number }): number {
  return scaleDelta(event.deltaX, event.deltaMode);
}

export function wheelDeltaY(event: { deltaY: number; deltaMode: number }): number {
  return scaleDelta(event.deltaY, event.deltaMode);
}

/** 一次滚轮事件对应的缩放倍率（> 1 放大）。`ctrlKey` 表示触控板捏合。 */
export function wheelZoomFactor(event: { deltaY: number; deltaMode: number; ctrlKey: boolean }): number {
  const gain = event.ctrlKey ? PINCH_ZOOM_GAIN : WHEEL_ZOOM_GAIN;
  const factor = Math.exp(-wheelDeltaY(event) * gain);
  if (!Number.isFinite(factor)) return 1;
  return Math.min(WHEEL_FACTOR_MAX, Math.max(WHEEL_FACTOR_MIN, factor));
}

/**
 * 触控板横向手势（|dx| 明显大于 |dy|）：应当平移而不是缩放。
 * 捏合永远算缩放 —— 捏合时浏览器也会给 deltaX，但 ctrlKey 已经说明意图。
 */
export function isHorizontalWheel(event: { deltaX: number; deltaY: number; ctrlKey: boolean }): boolean {
  return !event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5;
}
