/**
 * 窗口几何的可见性修正（纯函数，不引 electron）。
 *
 * 保存的 x/y 只对当时的显示器拓扑有意义：拔掉外接屏、改分辨率、换 DPI 之后，窗口可能
 * 整个落在可见区域之外 —— 表现为「启动后什么都没有」。这里在恢复时把窗口拉回某个工作区：
 *
 * - 保存的位置与任一工作区有足够重叠 → 原样使用（允许用户把窗口故意放在屏幕边缘）；
 * - 否则丢掉 x/y，让 Electron 居中到主屏；
 * - 宽高一律夹到最大工作区尺寸，避免超出屏幕。
 */

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface WindowPlacement {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** 判定「可见」所需的最小重叠：至少露出标题栏高度和一段可拖拽宽度。 */
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 48;

function overlap(left: WorkArea, right: WorkArea): { width: number; height: number } {
  return {
    width: Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
    height: Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  };
}

/** 按当前工作区修正保存的窗口状态；无工作区信息时原样返回。 */
export function placeWindow(state: SavedWindowState, workAreas: readonly WorkArea[]): WindowPlacement {
  if (workAreas.length === 0) return { ...state };

  const maxWidth = Math.max(...workAreas.map((area) => area.width));
  const maxHeight = Math.max(...workAreas.map((area) => area.height));
  const width = Math.min(state.width, maxWidth);
  const height = Math.min(state.height, maxHeight);
  const resized = { ...state, width, height };

  if (state.x === undefined || state.y === undefined) return resized;

  const rect: WorkArea = { x: state.x, y: state.y, width, height };
  const visible = workAreas.some((area) => {
    const hit = overlap(rect, area);
    return hit.width >= Math.min(MIN_VISIBLE_WIDTH, width) && hit.height >= Math.min(MIN_VISIBLE_HEIGHT, height);
  });
  if (visible) return resized;

  // 丢坐标 = 交给 Electron 居中；maximized 仍按保存值恢复。
  return { width, height, maximized: state.maximized };
}
