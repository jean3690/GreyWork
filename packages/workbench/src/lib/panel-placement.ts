/**
 * 胶囊弹出面板的方向决策（模型选择 / 权限档位共用）。
 *
 * 这些选择器长在输入卡底栏、贴着窗口底边：面板固定向下（top-full）会伸出视口，
 * 列表尾部点不到。打开前量一次锚点上下净空，下方装不下且上方更宽裕 → 向上弹（bottom-full）。
 * 只在 open 时量一次（与面板同生命周期），开着时改窗口尺寸不重算——面板随即会被点掉。
 */
import { ref, type Ref } from "vue";

/** 面板与锚点的间距（模板 mt-1 / mb-1）＋ 视口留白。 */
const EDGE_GAP = 12;

export interface PanelSpace {
  /** 锚点顶边（视口坐标）。 */
  anchorTop: number;
  /** 锚点底边（视口坐标）。 */
  anchorBottom: number;
  viewportHeight: number;
  /** 面板估算高（含搜索行与内边距）；渲染前量不到真高，估值只用于比较上下净空。 */
  panelHeight: number;
}

/** 纯决策：true = 向上弹。下方装不下、且上方比下方宽裕才翻转（两边都不够时取更宽的一侧）。 */
export function shouldOpenUp({ anchorTop, anchorBottom, viewportHeight, panelHeight }: PanelSpace): boolean {
  const below = viewportHeight - anchorBottom - EDGE_GAP;
  const above = anchorTop - EDGE_GAP;
  return below < panelHeight && above > below;
}

/**
 * 组件侧：`anchor` 绑定触发器所在的定位容器（relative 那层），`panelHeight` 为面板估算高
 * （内容随选项数变化时传 getter）。每次展开前调 `place()`，模板按 `openUp` 选 bottom-full / top-full。
 */
export function usePanelPlacement(
  anchor: Ref<HTMLElement | null>,
  panelHeight: number | (() => number),
): { openUp: Ref<boolean>; place: () => void } {
  const openUp = ref(false);

  function place(): void {
    const el = anchor.value;
    if (!el) {
      openUp.value = false;
      return;
    }
    const rect = el.getBoundingClientRect();
    openUp.value = shouldOpenUp({
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      viewportHeight: window.innerHeight || document.documentElement.clientHeight,
      panelHeight: typeof panelHeight === "function" ? panelHeight() : panelHeight,
    });
  }

  return { openUp, place };
}
