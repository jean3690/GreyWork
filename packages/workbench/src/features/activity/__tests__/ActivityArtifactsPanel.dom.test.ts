import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ArtifactsPanel from "@/features/activity/ArtifactsPanel.vue";
import { useArtifactStore } from "@/stores/artifact";

/**
 * 底部活动面板「产物」页签内容：全局产物 newest-first 渲染、
 * 点击名称开右栏预览（无 VFS 路径则标记不可用）、空态占位说明。
 */
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
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

  it("无 VFS 路径的产物按钮标记为不可用，且原因能通过提示读到", async () => {
    seed("disk-only.txt", "仅落盘", undefined);
    const wrapper = mountPanel();
    const button = wrapper.get('[data-testid="band-artifact-name"]');
    // 用 aria-disabled 而非原生 disabled：原生 disabled 收不到指针事件，提示永远弹不出来。
    expect(button.attributes("aria-disabled")).toBe("true");

    await button.trigger("focus");
    await flushPromises();
    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain("无法预览");
  });

  it("空态：占位文案，无列表", () => {
    const wrapper = mountPanel();
    expect(wrapper.find('[data-testid="artifacts-panel-empty"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("还没有全局产物");
    expect(wrapper.findAll('[data-testid="band-artifact"]')).toHaveLength(0);
  });
});
