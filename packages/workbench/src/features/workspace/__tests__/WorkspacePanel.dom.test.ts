/**
 * 工作区栏外壳的可观察行为：默认折叠（回到旧单右栏布局）、折叠即宽度归零且 aria-hidden、
 * 拖拽把手仅在展开时存在、折叠不卸载文件树（展开回来原地续上）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import WorkspacePanel from "@/features/workspace/WorkspacePanel.vue";
import { DEFAULT_WORKSPACE_PANEL_PX } from "@/lib/layout";
import { useWorkspacePanelStore } from "@/stores/workspacePanel";

function mountPanel() {
  return mount(WorkspacePanel);
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("WorkspacePanel", () => {
  it("默认折叠：宽度 0、aria-hidden、无把手，但文件树保持挂载", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    const aside = wrapper.get('[data-testid="workspace-panel"]');
    expect(aside.attributes("style")).toContain("width: 0px");
    expect(aside.attributes("aria-hidden")).toBe("true");
    expect(wrapper.find('[data-testid="workspace-resize-handle"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true);
  });

  it("展开：可见、挂出文件树、带拖拽把手", async () => {
    const wrapper = mountPanel();
    const workspace = useWorkspacePanelStore();
    workspace.setCollapsed(false);
    await wrapper.vm.$nextTick();

    const aside = wrapper.get('[data-testid="workspace-panel"]');
    expect(aside.attributes("aria-hidden")).toBeUndefined();
    expect(aside.attributes("style")).toContain(`width: ${DEFAULT_WORKSPACE_PANEL_PX}px`);
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="workspace-resize-handle"]').exists()).toBe(true);
  });

  it("折叠按钮把面板收起，但文件树不卸载（展开后把手与宽度恢复）", async () => {
    const wrapper = mountPanel();
    const workspace = useWorkspacePanelStore();
    workspace.setCollapsed(false);
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="workspace-collapse"]').trigger("click");

    const aside = wrapper.get('[data-testid="workspace-panel"]');
    expect(workspace.collapsed).toBe(true);
    expect(aside.attributes("style")).toContain("width: 0px");
    expect(aside.attributes("aria-hidden")).toBe("true");
    expect(wrapper.find('[data-testid="workspace-resize-handle"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true);

    workspace.setCollapsed(false);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="workspace-resize-handle"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="workspace-panel"]').attributes("style")).not.toContain("width: 0px");
  });
});
