/**
 * 交付物卡片：磁盘路径决定「在文件夹中打开」可用性 —— 有路径才可点，
 * 浏览器态（无 diskPath）按钮标记为不可用而不是点了没反应；未登记的 id 静默跳过。
 *
 * 不可用用的是 aria-disabled 而不是原生 disabled：原生 disabled 的元素收不到指针事件，
 * 于是「为什么不可用」的提示永远弹不出来（原生 title 在 disabled 上本就不可靠）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({ reveal: vi.fn<(path: string) => Promise<boolean>>() }));

vi.mock("@/lib/reveal", () => ({ revealInFolder: (path: string) => h.reveal(path) }));

import ArtifactCards from "@/features/activity/ArtifactCards.vue";
import { useArtifactStore } from "@/stores/artifact";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.reveal.mockResolvedValue(true);
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** 提示内容 Portal 到 body 且只在触发时挂载；textContent 含 reka 的隐藏测量副本，用 toContain。 */
function tooltipText(): string {
  return document.body.querySelector('[data-slot="tooltip-content"]')?.textContent ?? "";
}

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
    expect(button.attributes("aria-disabled")).toBeUndefined();

    await button.trigger("click");
    expect(h.reveal).toHaveBeenCalledWith("/home/u/.greyWork/artifacts/report.md");
  });

  it("无磁盘路径：按钮标记为不可用，且原因能通过提示读到", async () => {
    const wrapper = mount(ArtifactCards, { props: { ids: [seed()] } });
    const button = wrapper.get('[data-testid="artifact-reveal"]');
    expect(button.attributes("aria-disabled")).toBe("true");

    // 关键差异：不是原生 disabled，所以还能聚焦，提示才弹得出来（键盘用户也能拿到原因）。
    await button.trigger("focus");
    await flushPromises();
    expect(tooltipText()).toContain("未落盘");
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
