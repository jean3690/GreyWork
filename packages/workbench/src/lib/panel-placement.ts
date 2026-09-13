/**
 * 胶囊弹出面板的方向与水平对齐决策（模型选择 / 权限档位共用）。
 *
 * 这些选择器位于输入框下方：纵向按上下净空翻转；横向默认右对齐，但若面板会越过
 * 所在 main 的左边界（进入侧栏或被 main overflow 裁切），则改为从触发器左侧向右展开。
 * 只在 open 时量一次；面板随点击外部关闭，窗口变更无需持续监听。
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

/** true = 改为左对齐（面板从锚点向右展开），避免右对齐越过可见容器左边界。 */
export function shouldAlignLeft(anchorRight: number, panelWidth: number, boundaryLeft: number): boolean {
  return anchorRight - panelWidth < boundaryLeft + EDGE_GAP;
}

/**
 * 组件侧：`anchor` 绑定触发器所在的定位容器（relative 那层）；每次展开前调 `place()`，
 * 模板按 `openUp` 选 bottom-full / top-full，按 `alignLeft` 选 left-0 / right-0。
 */
export function usePanelPlacement(
  anchor: Ref<HTMLElement | null>,
  panelHeight: number | (() => number),
  panelWidth: number,
): { openUp: Ref<boolean>; alignLeft: Ref<boolean>; place: () => void } {
  const openUp = ref(false);
  const alignLeft = ref(false);

  function place(): void {
    const el = anchor.value;
    if (!el) {
      openUp.value = false;
      alignLeft.value = false;
      return;
    }
    const rect = el.getBoundingClientRect();
    openUp.value = shouldOpenUp({
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      viewportHeight: window.innerHeight || document.documentElement.clientHeight,
      panelHeight: typeof panelHeight === "function" ? panelHeight() : panelHeight,
    });
    const boundaryLeft = el.closest("main")?.getBoundingClientRect().left ?? 0;
    alignLeft.value = shouldAlignLeft(rect.right, panelWidth, boundaryLeft);
  }

  return { openUp, alignLeft, place };
}
