/**
 * 右栏宽度约束：这两个纯函数决定「右栏多宽」与「还该不该显示」，
 * 是唯一能防止右栏把会话区挤破的地方。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREVIEW_PANEL_PX,
  MAX_PREVIEW_PANEL_PX,
  MIN_CONTENT_PX,
  MIN_PREVIEW_PANEL_PX,
  clampPreviewWidth,
  shouldAutoCollapse,
} from "@/lib/layout";

describe("clampPreviewWidth", () => {
  it("收进 [MIN, MAX] 区间", () => {
    expect(clampPreviewWidth(10)).toBe(MIN_PREVIEW_PANEL_PX);
    expect(clampPreviewWidth(99999)).toBe(MAX_PREVIEW_PANEL_PX);
    expect(clampPreviewWidth(DEFAULT_PREVIEW_PANEL_PX)).toBe(DEFAULT_PREVIEW_PANEL_PX);
  });

  it("取整（拖拽产生的小数不该进 style）", () => {
    expect(clampPreviewWidth(420.6)).toBe(421);
  });

  it("availableWidth 省略或为 0 时不施加容器上限（首帧未测量）", () => {
    expect(clampPreviewWidth(MAX_PREVIEW_PANEL_PX)).toBe(MAX_PREVIEW_PANEL_PX);
    expect(clampPreviewWidth(MAX_PREVIEW_PANEL_PX, 0)).toBe(MAX_PREVIEW_PANEL_PX);
  });

  it("容器上限 = availableWidth - MIN_CONTENT_PX，给会话区留够空间", () => {
    const available = MIN_CONTENT_PX + 400;
    expect(clampPreviewWidth(MAX_PREVIEW_PANEL_PX, available)).toBe(400);
  });

  it("容器再窄，也不会低于 MIN_PREVIEW_PANEL_PX（宁可挤会话区也不给一个不可用的宽度）", () => {
    expect(clampPreviewWidth(DEFAULT_PREVIEW_PANEL_PX, 100)).toBe(MIN_PREVIEW_PANEL_PX);
  });
});

describe("shouldAutoCollapse", () => {
  it("未测量（0）时不折叠", () => {
    expect(shouldAutoCollapse(0)).toBe(false);
  });

  it("装不下「最小会话区 + 最小右栏」时折叠", () => {
    expect(shouldAutoCollapse(MIN_CONTENT_PX + MIN_PREVIEW_PANEL_PX - 1)).toBe(true);
  });

  it("刚好装得下时不折叠（边界不该抖动）", () => {
    expect(shouldAutoCollapse(MIN_CONTENT_PX + MIN_PREVIEW_PANEL_PX)).toBe(false);
    expect(shouldAutoCollapse(MIN_CONTENT_PX + MIN_PREVIEW_PANEL_PX + 1)).toBe(false);
  });
});
