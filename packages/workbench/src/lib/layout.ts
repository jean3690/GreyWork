/**
 * 右栏（预览面板）布局常量与宽度约束 —— store / 组件 / 测试的单一来源。
 *
 * 右栏是**固定 px 宽**而非容器百分比：窗口尺寸变化由中间会话区吸收。若按百分比切分，
 * 拖窄窗口时预览与会话会一起缩到两边都不可用；固定 px 则只有会话区变窄，预览始终可读。
 * 420 取自 ui-design.md 的右栏规格（<1400 缩至 300px 的退让由 clampPreviewWidth 承担）。
 */

export const MIN_PREVIEW_PANEL_PX = 320;
export const MAX_PREVIEW_PANEL_PX = 720;
export const DEFAULT_PREVIEW_PANEL_PX = 420;

/** 会话区最小可用宽：右栏再宽也不能把它挤破。 */
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

/**
 * 把用户偏好宽度收进合法区间。
 *
 * `availableWidth` 是 [会话区 + 右栏] 这一行的**实测**宽度 —— 它与切分结果无关，
 * 所以拿它做上限不会形成「宽度依赖宽度」的循环。传 0 表示尚未测量（首帧 / 测试），
 * 此时只按 MIN/MAX 收敛，不施加容器上限。
 */
export function clampPreviewWidth(requestedPx: number, availableWidth = 0): number {
  const bounded = Math.min(MAX_PREVIEW_PANEL_PX, Math.max(MIN_PREVIEW_PANEL_PX, Math.round(requestedPx)));
  if (availableWidth <= 0) return bounded;
  const maxByContainer = Math.max(MIN_PREVIEW_PANEL_PX, Math.round(availableWidth) - MIN_CONTENT_PX);
  return Math.min(bounded, maxByContainer);
}

/**
 * 容器窄到连「最小会话区 + 最小右栏」都装不下时，右栏应自动折叠。
 * 与 clampPreviewWidth 分开：前者管「多宽」，这里管「还该不该显示」——
 * 挤到 320 还装不下时继续压宽度只会两边都废掉，折叠是唯一可用解。
 */
export function shouldAutoCollapse(availableWidth: number): boolean {
  return availableWidth > 0 && availableWidth < MIN_CONTENT_PX + MIN_PREVIEW_PANEL_PX;
}
