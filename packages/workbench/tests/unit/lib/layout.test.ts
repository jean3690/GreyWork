/**
 * 面板宽度约束：这些纯函数决定「面板多宽」与「还该不该显示」，
 * 是唯一能防止面板把会话区挤破的地方。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREVIEW_PANEL_PX,
  DEFAULT_WORKSPACE_PANEL_PX,
  MAX_PREVIEW_PANEL_PX,
  MAX_WORKSPACE_PANEL_PX,
  MIN_CONTENT_PX,
  MIN_PREVIEW_PANEL_PX,
  MIN_WORKSPACE_PANEL_PX,
  clampPreviewWidth,
  clampWorkspaceWidth,
  shouldAutoCollapse,
  shouldAutoCollapseWorkspace,
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

  it("预留伙伴宽度后，容器上限再退让 reservedPx（两面板联手才能挤破会话区）", () => {
    expect(clampPreviewWidth(MAX_PREVIEW_PANEL_PX, 1000, 200)).toBe(440);
  });

  it("预留为 0 时与旧的双参行为一致（伙伴折叠）", () => {
    expect(clampPreviewWidth(MAX_PREVIEW_PANEL_PX, 1000, 0)).toBe(640);
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

  it("伙伴展开时阈值加上伙伴宽度：与此同时装不下的空间差一点就得折叠", () => {
    const reserved = MIN_WORKSPACE_PANEL_PX;
    expect(shouldAutoCollapse(MIN_CONTENT_PX + MIN_PREVIEW_PANEL_PX + reserved - 1, reserved)).toBe(true);
    expect(shouldAutoCollapse(MIN_CONTENT_PX + MIN_PREVIEW_PANEL_PX + reserved, reserved)).toBe(false);
  });
});

describe("clampWorkspaceWidth", () => {
  it("收进 [220, 500] 区间", () => {
    expect(clampWorkspaceWidth(10)).toBe(MIN_WORKSPACE_PANEL_PX);
    expect(clampWorkspaceWidth(99999)).toBe(MAX_WORKSPACE_PANEL_PX);
    expect(clampWorkspaceWidth(DEFAULT_WORKSPACE_PANEL_PX)).toBe(DEFAULT_WORKSPACE_PANEL_PX);
  });

  it("取整", () => {
    expect(clampWorkspaceWidth(260.6)).toBe(261);
  });

  it("availableWidth 省略或为 0 时不施加容器上限", () => {
    expect(clampWorkspaceWidth(MAX_WORKSPACE_PANEL_PX)).toBe(MAX_WORKSPACE_PANEL_PX);
    expect(clampWorkspaceWidth(MAX_WORKSPACE_PANEL_PX, 0)).toBe(MAX_WORKSPACE_PANEL_PX);
  });

  it("容器上限 = availableWidth - MIN_CONTENT_PX - reservedPx，给会话区与右栏留够空间", () => {
    const available = MIN_CONTENT_PX + 300;
    expect(clampWorkspaceWidth(MAX_WORKSPACE_PANEL_PX, available)).toBe(300);
    expect(clampWorkspaceWidth(MAX_WORKSPACE_PANEL_PX, 1000, 300)).toBe(340);

    // 再窄也不低于 MIN_WORKSPACE_PANEL_PX
    expect(clampWorkspaceWidth(DEFAULT_WORKSPACE_PANEL_PX, 100)).toBe(MIN_WORKSPACE_PANEL_PX);
  });
});

describe("shouldAutoCollapseWorkspace", () => {
  it("未测量（0）时不折叠", () => {
    expect(shouldAutoCollapseWorkspace(0)).toBe(false);
  });

  it("装不下「最小会话区 + 最小工作区栏」时折叠", () => {
    expect(shouldAutoCollapseWorkspace(MIN_CONTENT_PX + MIN_WORKSPACE_PANEL_PX - 1)).toBe(true);
    expect(shouldAutoCollapseWorkspace(MIN_CONTENT_PX + MIN_WORKSPACE_PANEL_PX)).toBe(false);
  });

  it("右栏展开时阈值加上右栏最小宽", () => {
    const reserved = MIN_PREVIEW_PANEL_PX;
    expect(shouldAutoCollapseWorkspace(MIN_CONTENT_PX + MIN_WORKSPACE_PANEL_PX + reserved - 1, reserved)).toBe(true);
    expect(shouldAutoCollapseWorkspace(MIN_CONTENT_PX + MIN_WORKSPACE_PANEL_PX + reserved, reserved)).toBe(false);
  });
});
