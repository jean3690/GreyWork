import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { DEFAULT_WORKSPACE_PANEL_PX, clampWorkspaceWidth, shouldAutoCollapseWorkspace } from "../lib/layout";

/**
 * 工作区栏（会话区与预览之间的文件面板）宿主状态：折叠 + 宽度偏好 + 可用性。
 *
 * 逻辑与 preview store 的宽度部分对称（px + 比例双存储、伙伴预留、窄屏自动折叠），
 * 但没有 tab / 事件 —— 内容只挂 FileTree，是纯宿主。默认展开：它就是给三栏
 * chat | workspace | preview 布局存在的，收起来等于退回旧布局。
 */
interface WorkspacePanelPrefs {
  collapsed: boolean;
  widthPx: number;
  /** 上次拖拽提交时面板占整行（会话+工作区+预览）的比例；窗口缩放时按它重算宽度。 */
  ratio: number | null;
}

function isPrefs(value: unknown): value is WorkspacePanelPrefs {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.collapsed === "boolean" &&
    typeof record.widthPx === "number" &&
    (record.ratio === undefined || record.ratio === null || typeof record.ratio === "number")
  );
}

const prefsStorage = createJsonStorage<WorkspacePanelPrefs>("greywork.workspace.panel", isPrefs);

export const useWorkspacePanelStore = defineStore("workspacePanel", () => {
  const savedPrefs = prefsStorage.read();
  /**
   * 默认折叠：三栏不是每个人都想要 —— 右栏自己就有「文件/预览」区段，工作区栏的文件树
   * 与它功能重叠。默认回到旧布局（会话 | 右栏），需要时用标题栏按钮 / Ctrl+E 展开。
   */
  const collapsed = ref(savedPrefs?.collapsed ?? true);
  const widthPx = ref(clampWorkspaceWidth(savedPrefs?.widthPx ?? DEFAULT_WORKSPACE_PANEL_PX));
  const ratio = ref<number | null>(savedPrefs?.ratio ?? null);
  /** 伙伴面板（预览面板）当前占用的宽度：由 Shell 回灌，0 = 伙伴折叠。 */
  const reservedPx = ref(0);
  /** 整行实测宽度，由 Shell 的 ResizeObserver 回灌；0 = 未测量。 */
  const availableWidth = ref(0);
  /** 当前视口是否渲染工作区栏（窄屏不渲染），由 Shell 的视口同步回灌。 */
  const available = ref(true);

  /** 生效宽度：折叠为 0，否则按实测容器宽度与伙伴预留收敛偏好值。 */
  const effectiveWidthPx = computed(() =>
    collapsed.value ? 0 : clampWorkspaceWidth(widthPx.value, availableWidth.value, reservedPx.value),
  );

  function persist(): void {
    prefsStorage.write({ collapsed: collapsed.value, widthPx: widthPx.value, ratio: ratio.value });
  }

  function setCollapsed(value: boolean): void {
    collapsed.value = value;
    persist();
  }

  function toggle(): void {
    setCollapsed(!collapsed.value);
  }

  /** 拖拽提交宽度；`commit` 为 false 时只更新视图不写盘。 */
  function setWidth(px: number, commit = true): void {
    widthPx.value = clampWorkspaceWidth(px, availableWidth.value, reservedPx.value);
    if (!commit) return;
    if (availableWidth.value > 0) ratio.value = widthPx.value / availableWidth.value;
    persist();
  }

  /** 容器实测宽度回灌；有已记录比例则按比例重算，窄到装不下时自动折叠。 */
  function setAvailableWidth(px: number): void {
    if (px > 0 && ratio.value && ratio.value > 0 && !collapsed.value) {
      widthPx.value = clampWorkspaceWidth(Math.round(ratio.value * px), px, reservedPx.value);
    }
    availableWidth.value = px;
    if (!collapsed.value && shouldAutoCollapseWorkspace(px, reservedPx.value)) setCollapsed(true);
  }

  /** 伙伴面板（预览面板）当前占用宽度回灌；改它只影响生效宽度，不动偏好。 */
  function setReserved(px: number): void {
    reservedPx.value = px;
  }

  /** 窄屏可用性回灌：不动折叠偏好（与 preview.setAvailable 同语义）。 */
  function setAvailable(value: boolean): void {
    available.value = value;
  }

  return {
    collapsed,
    widthPx,
    ratio,
    reservedPx,
    availableWidth,
    available,
    effectiveWidthPx,
    setCollapsed,
    toggle,
    setWidth,
    setAvailableWidth,
    setReserved,
    setAvailable,
  };
});
