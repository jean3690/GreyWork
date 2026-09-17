/**
 * Markdown 预览（MarkdownViewer）：加载态 / 失败态 / 正常渲染。
 * 断言的核心是「内容确实经过了渲染管线」：markdown 语法没漏进文本、
 * 读取按 tab 的 path 发出去 —— 分派正确，喂错路径就会在别处坏。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({ readFile: vi.fn<(path: string) => Promise<string>>() }));
vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readFile: h.readFile }) }));

import MarkdownViewer from "@/features/preview/MarkdownViewer.vue";

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "reports/a.md", name: "a.md", kind: "md", source: "vfs", revision: 0, ...partial };
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  h.readFile.mockReset();
  h.readFile.mockResolvedValue("# 标题\n\n正文 **粗体** 结尾");
});

describe("MarkdownViewer", () => {
  it("读取中：显示加载占位", () => {
    h.readFile.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(MarkdownViewer, { props: { tab: tab() } });
    expect(wrapper.text()).toContain("读取中");
  });

  it("读取失败：alert + 错误文案", async () => {
    h.readFile.mockRejectedValue(new Error("no such file"));
    const wrapper = mount(MarkdownViewer, { props: { tab: tab() } });
    await flushPromises();

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain("读取失败：no such file");
  });

  it("渲染 markdown：语法被解析而不是原样漏出，读取按 tab.path 发出", async () => {
    const wrapper = mount(MarkdownViewer, { props: { tab: tab() } });
    await flushPromises();

    expect(h.readFile).toHaveBeenCalledTimes(1);
    expect(h.readFile).toHaveBeenCalledWith("reports/a.md");
    const viewer = wrapper.get('[data-testid="markdown-viewer"]');
    expect(viewer.text()).toContain("标题");
    expect(viewer.text()).toContain("正文");
    expect(viewer.text()).toContain("粗体");
    expect(viewer.text()).not.toContain("**");
    expect(viewer.find("strong").text()).toBe("粗体");
  });
});
