/**
 * 面板宽度常量与约束函数 —— store / 组件 / 测试的单一来源。
 *
 * 右栏（预览面板）与工作区栏是**固定 px 宽**而非容器百分比：窗口尺寸变化由中间会话区
 * 吸收。若按百分比切分，拖窄窗口时预览与会话会一起缩到两边都不可用；固定 px 则只有
 * 会话区变窄，面板始终可读。
 *
 * 伙伴面板预留：当两个面板同时展开时，clamp 函数接受 `reservedPx` 参数表示伙伴面板的
 * 当前偏好宽度，确保两面板不会联手把会话区挤到低于 `MIN_CONTENT_PX`。`reservedPx`
 * 只按伙伴的**偏好宽**（非实测）推算——不形成宽度依赖宽度的循环。
 */

/* ── 预览面板 ──────────────────────────────────────────────────────────── */

export const MIN_PREVIEW_PANEL_PX = 320;
export const MAX_PREVIEW_PANEL_PX = 720;
export const DEFAULT_PREVIEW_PANEL_PX = 420;

/* ── 工作区栏 ──────────────────────────────────────────────────────────── */

export const MIN_WORKSPACE_PANEL_PX = 220;
export const MAX_WORKSPACE_PANEL_PX = 500;
export const DEFAULT_WORKSPACE_PANEL_PX = 260;

/* ── 共享常量 ──────────────────────────────────────────────────────────── */

/** 会话区最小可用宽：面板再宽也不能把它挤破。 */
export const MIN_CONTENT_PX = 360;

/** 预览 tab 条高度（与 Sider 工具条同高，横向对齐）。 */
export const PREVIEW_TAB_BAR_HEIGHT = 34;

/**
 * 底部活动面板高度（含标签条）：固定高 + 内部滚动；v1 不做拖拽调高。
 * 收起 = 高度归零（过渡），内容保持挂载，与右栏折叠同一策略。
 */
export const ACTIVITY_BAND_HEIGHT_PX = 220;

/** 左栏插件分组宿主最大高：超出内部滚动，防止单个高分组把会话历史压垮。 */
export const SIDEBAR_REGIONS_MAX_HEIGHT_PX = 240;

/** 同时打开的预览 tab 上限：超出丢最旧的非激活 tab（防止一路产物把内存和 tab 条撑爆）。 */
export const MAX_PREVIEW_TABS = 12;

/* ── 预览面板宽度约束 ──────────────────────────────────────────────────── */

/**
 * 把用户偏好宽度收进合法区间。
 *
 * `availableWidth` 是 [会话区 + 右栏] 这一行的**实测**宽度 —— 它与切分结果无关，
 * 所以拿它做上限不会形成「宽度依赖宽度」的循环。传 0 表示尚未测量（首帧 / 测试），
 * 此时只按 MIN/MAX 收敛，不施加容器上限。
 *
 * `reservedPx` 是伙伴面板（工作区栏）的当前偏好宽度；0 表示伙伴折叠或未展开，
 * 此时退化为旧的单面板约束。
 */
export function clampPreviewWidth(requestedPx: number, availableWidth = 0, reservedPx = 0): number {
  const bounded = Math.min(MAX_PREVIEW_PANEL_PX, Math.max(MIN_PREVIEW_PANEL_PX, Math.round(requestedPx)));
  if (availableWidth <= 0) return bounded;
  const maxByContainer = Math.max(MIN_PREVIEW_PANEL_PX, Math.round(availableWidth) - MIN_CONTENT_PX - reservedPx);
  return Math.min(bounded, maxByContainer);
}

/**
 * 容器窄到连「最小会话区 + 最小右栏」都装不下时，右栏应自动折叠。
 * 与 clampPreviewWidth 分开：前者管「多宽」，这里管「还该不该显示」——
 * 挤到最小值还装不下时继续压宽度只会两边都废掉，折叠是唯一可用解。
 *
 * `reservedPx` 是伙伴面板当前宽度：若伙伴展开，装不下的阈值要加上伙伴的最小宽。
 */
export function shouldAutoCollapse(availableWidth: number, reservedPx = 0): boolean {
  return availableWidth > 0 && availableWidth < MIN_CONTENT_PX + MIN_PREVIEW_PANEL_PX + reservedPx;
}

/* ── 工作区栏宽度约束 ──────────────────────────────────────────────────── */

/**
 * 把工作区栏的偏好宽度收进合法区间。逻辑与 clampPreviewWidth 对称。
 */
export function clampWorkspaceWidth(requestedPx: number, availableWidth = 0, reservedPx = 0): number {
  const bounded = Math.min(MAX_WORKSPACE_PANEL_PX, Math.max(MIN_WORKSPACE_PANEL_PX, Math.round(requestedPx)));
  if (availableWidth <= 0) return bounded;
  const maxByContainer = Math.max(MIN_WORKSPACE_PANEL_PX, Math.round(availableWidth) - MIN_CONTENT_PX - reservedPx);
  return Math.min(bounded, maxByContainer);
}

/**
 * 工作区栏自动折叠判断：与 shouldAutoCollapse 对称。
 */
export function shouldAutoCollapseWorkspace(availableWidth: number, reservedPx = 0): boolean {
  return availableWidth > 0 && availableWidth < MIN_CONTENT_PX + MIN_WORKSPACE_PANEL_PX + reservedPx;
}
