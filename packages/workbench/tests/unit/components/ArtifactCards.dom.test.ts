/**
 * 交付物卡片：磁盘路径决定「在文件夹中打开」可用性 —— 有路径才可点，
 * 浏览器态（无 diskPath）按钮禁用而不是点了没反应；未登记的 id 静默跳过。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({ reveal: vi.fn<(path: string) => Promise<boolean>>() }));

vi.mock("@/lib/reveal", () => ({ revealInFolder: (path: string) => h.reveal(path) }));

import ArtifactCards from "@/components/ArtifactCards.vue";
import { useArtifactStore } from "@/stores/artifact";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.reveal.mockResolvedValue(true);
});

function seed(diskPath?: string): string {
  return useArtifactStore().pushArtifact({
    name: "report.md",
    meta: "Markdown · 任务产物",
    type: "report",
    source: "assistant-pipeline",
    diskPath,
  });
}

describe("ArtifactCards", () => {
  it("有磁盘路径：展示路径且点击调用 revealInFolder", async () => {
    const id = seed("/home/u/.greyWork/artifacts/report.md");
    const wrapper = mount(ArtifactCards, { props: { ids: [id] } });

    expect(wrapper.findAll('[data-testid="artifact-card"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("/home/u/.greyWork/artifacts/report.md");
    const button = wrapper.get('[data-testid="artifact-reveal"]');
    expect(button.attributes("disabled")).toBeUndefined();

    await button.trigger("click");
    expect(h.reveal).toHaveBeenCalledWith("/home/u/.greyWork/artifacts/report.md");
  });

  it("无磁盘路径：按钮禁用并说明原因", () => {
    const wrapper = mount(ArtifactCards, { props: { ids: [seed()] } });
    const button = wrapper.get('[data-testid="artifact-reveal"]');
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toContain("未落盘");
  });

  it("打开失败就地提示，不抛错", async () => {
    h.reveal.mockResolvedValue(false);
    const wrapper = mount(ArtifactCards, { props: { ids: [seed("/gone/report.md")] } });
    await wrapper.get('[data-testid="artifact-reveal"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("打开失败");
  });

  it("未登记的 id 被跳过（历史消息里的旧产物 id 不该炸）", () => {
    const wrapper = mount(ArtifactCards, { props: { ids: ["af-does-not-exist"] } });
    expect(wrapper.findAll('[data-testid="artifact-card"]')).toHaveLength(0);
  });
});
