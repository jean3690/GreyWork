/**
 * 工作区栏 store：默认展开、宽度收敛、折叠为 0、px+比例双存储、伙伴预留、窄屏自动折叠。
 * 与 preview store 的宽度逻辑对称，但更薄（只有宿主状态，没有 tab/事件）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
};
vi.stubGlobal("localStorage", localStorageStub);
vi.stubGlobal("window", { localStorage: localStorageStub });

import {
  DEFAULT_WORKSPACE_PANEL_PX,
  MAX_WORKSPACE_PANEL_PX,
  MIN_CONTENT_PX,
  MIN_PREVIEW_PANEL_PX,
  MIN_WORKSPACE_PANEL_PX,
} from "@/lib/layout";
import { useWorkspacePanelStore } from "@/stores/workspacePanel";

beforeEach(() => {
  storage.clear();
  setActivePinia(createPinia());
});

describe("useWorkspacePanelStore", () => {
  it("默认折叠（回到旧单右栏布局，三栏是可选能力）、默认宽 260", () => {
    const workspace = useWorkspacePanelStore();
    expect(workspace.collapsed).toBe(true);
    expect(workspace.widthPx).toBe(DEFAULT_WORKSPACE_PANEL_PX);
  });

  it("宽度收进 [220, 500]", () => {
    const workspace = useWorkspacePanelStore();
    workspace.setWidth(10, true);
    expect(workspace.widthPx).toBe(MIN_WORKSPACE_PANEL_PX);
    workspace.setWidth(99999, true);
    expect(workspace.widthPx).toBe(MAX_WORKSPACE_PANEL_PX);
  });

  it("折叠时生效宽度为 0，展开时回到收敛后的偏好宽", () => {
    const workspace = useWorkspacePanelStore();
    expect(workspace.effectiveWidthPx).toBe(0);

    workspace.setCollapsed(false);
    workspace.setAvailableWidth(1000);
    workspace.setWidth(300, true);
    expect(workspace.effectiveWidthPx).toBe(300);

    workspace.setCollapsed(true);
    expect(workspace.effectiveWidthPx).toBe(0);
    workspace.setCollapsed(false);
    expect(workspace.effectiveWidthPx).toBe(300);
  });

  it("拖拽提交时记比例；窗口缩放按比例重算 px", () => {
    const workspace = useWorkspacePanelStore();
    workspace.setCollapsed(false);
    workspace.setAvailableWidth(1000);
    workspace.setWidth(300, true);
    expect(workspace.ratio).toBeCloseTo(0.3);

    workspace.setAvailableWidth(1300);
    expect(workspace.widthPx).toBe(390);
    expect(workspace.effectiveWidthPx).toBe(390);
  });

  it("未测宽时提交宽度不记比例", () => {
    const workspace = useWorkspacePanelStore();
    workspace.setWidth(300, true);
    expect(workspace.ratio).toBeNull();
  });

  it("伙伴（预览）预留会挤压生效宽度，但不改偏好", () => {
    const workspace = useWorkspacePanelStore();
    workspace.setCollapsed(false);
    workspace.setAvailableWidth(1000);
    workspace.setWidth(400, true);
    workspace.setReserved(MIN_PREVIEW_PANEL_PX);
    // 容器上限 = 1000 - MIN_CONTENT - 320 = 320，偏好 400 被挤到 320
    expect(workspace.effectiveWidthPx).toBe(320);
    expect(workspace.widthPx).toBe(400);
  });

  it("容器不够宽时偏好与生效宽度都收敛到容器上限（setWidth 落的就是收敛值）", () => {
    const workspace = useWorkspacePanelStore();
    workspace.setCollapsed(false);
    workspace.setAvailableWidth(MIN_CONTENT_PX + 300);
    workspace.setWidth(500, true);
    // 容器上限 = 360+300-360 = 300
    expect(workspace.effectiveWidthPx).toBe(300);
    expect(workspace.widthPx).toBe(300);
  });

  it("窄到装不下会话区 + 工作区栏时自动折叠", () => {
    const workspace = useWorkspacePanelStore();
    workspace.setCollapsed(false);
    expect(workspace.collapsed).toBe(false);
    workspace.setAvailableWidth(MIN_CONTENT_PX + MIN_WORKSPACE_PANEL_PX - 1);
    expect(workspace.collapsed).toBe(true);
  });

  it("折叠偏好与持久化同源：切换后重启读回", () => {
    const workspace = useWorkspacePanelStore();
    workspace.setWidth(320, true);
    workspace.setCollapsed(false);

    setActivePinia(createPinia());
    const reloaded = useWorkspacePanelStore();
    expect(reloaded.collapsed).toBe(false);
    expect(reloaded.widthPx).toBe(320);
  });

  it("落盘形状不对时退回默认值（默认折叠）", () => {
    storage.set("greywork.workspace.panel", "{ 不是 JSON");
    const workspace = useWorkspacePanelStore();
    expect(workspace.collapsed).toBe(true);
    expect(workspace.widthPx).toBe(DEFAULT_WORKSPACE_PANEL_PX);
  });

  it("setAvailable 只改可用性，不动折叠偏好（窄屏切回要能恢复）", () => {
    const workspace = useWorkspacePanelStore();
    workspace.setCollapsed(false);
    workspace.setAvailable(false);
    expect(workspace.available).toBe(false);
    expect(workspace.collapsed).toBe(false);

    workspace.setAvailable(true);
    expect(workspace.collapsed).toBe(false);
  });
});
