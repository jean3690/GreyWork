/**
 * 客户区矩形归一化（纯函数：脱开 Electron 也能单测）。
 *
 * 入参来自渲染端 IPC，形状按约定但不保证合法 —— 非数字落 0、宽高非负、取整
 * （`WebContentsView.setBounds` 只吃整数像素）。与 Tauri 壳 `browser.rs` 的 `sanitize_rect`
 * 同口径：**CSS px（= DIP）直接传，不乘 scaleFactor**。
 */
export interface HostRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function sanitizeRect(rect: unknown): HostRect | null {
  if (!rect || typeof rect !== "object") return null;
  const value = rect as Record<string, unknown>;
  const num = (input: unknown): number => (typeof input === "number" && Number.isFinite(input) ? input : 0);
  return {
    x: Math.round(num(value.x)),
    y: Math.round(num(value.y)),
    width: Math.max(0, Math.round(num(value.width))),
    height: Math.max(0, Math.round(num(value.height))),
  };
}
