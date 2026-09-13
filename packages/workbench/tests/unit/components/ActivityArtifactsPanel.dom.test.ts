import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ArtifactsPanel from "@/components/activity/ArtifactsPanel.vue";
import { useArtifactStore } from "@/stores/artifact";

/**
 * 底部活动面板「产物」页签内容：全局产物 newest-first 渲染、
 * 点击名称开右栏预览（无 VFS 路径则禁用）、空态占位说明。
 */
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

function seed(name: string, meta: string, path?: string): void {
  useArtifactStore().pushArtifact({ name, meta, type: "report", source: "assistant-pipeline", path });
}

function mountPanel(): ReturnType<typeof mount> {
  return mount(ArtifactsPanel);
}

describe("ArtifactsPanel", () => {
  it("全局产物 newest-first 渲染（后投递的排前）", () => {
    seed("report-a.md", "Markdown · 报告", "artifacts/report-a.md");
    seed("report-b.csv", "CSV · 数据", "artifacts/report-b.csv");
    const wrapper = mountPanel();

    const rows = wrapper.findAll('[data-testid="band-artifact"]');
    expect(rows).toHaveLength(2);
    const names = rows.map((row) => row.get('[data-testid="band-artifact-name"]').text());
    expect(names).toEqual(["report-b.csv", "report-a.md"]);
    expect(wrapper.text()).toContain("CSV · 数据");
    expect(wrapper.text()).toContain("Markdown · 报告");
  });

  it("点击名称调用 preview.open 并展开右栏", async () => {
    seed("report-a.md", "Markdown · 报告", "artifacts/report-a.md");
    const wrapper = mountPanel();
    const { usePreviewStore } = await import("@/stores/preview");
    const preview = usePreviewStore();

    await wrapper.get('[data-testid="band-artifact-name"]').trigger("click");

    expect(preview.tabs.some((tab) => tab.path === "artifacts/report-a.md" && tab.name === "report-a.md")).toBe(true);
    expect(preview.collapsed).toBe(false);
    expect(preview.activeId).toBe(preview.tabs[0]?.id ?? null);
  });

  it("无 VFS 路径的产物按钮禁用并说明", () => {
    seed("disk-only.txt", "仅落盘", undefined);
    const wrapper = mountPanel();
    const button = wrapper.get('[data-testid="band-artifact-name"]');
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toContain("无法预览");
  });

  it("空态：占位文案，无列表", () => {
    const wrapper = mountPanel();
    expect(wrapper.find('[data-testid="artifacts-panel-empty"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("还没有全局产物");
    expect(wrapper.findAll('[data-testid="band-artifact"]')).toHaveLength(0);
  });
});
