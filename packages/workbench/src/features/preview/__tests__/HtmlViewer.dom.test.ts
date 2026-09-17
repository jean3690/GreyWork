/**
 * HTML 预览（HtmlViewer）：渲染/源码双态切换 + iframe 沙箱。
 * 沙箱是这份组件的安全边界：iframe 必须用 srcdoc 注入、必须不含 allow-scripts ——
 * 被预览的 HTML 多半是模型拼的，给脚本 = 能读同源存储、能发请求。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({ readFile: vi.fn<(path: string) => Promise<string>>() }));
vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readFile: h.readFile }) }));

import HtmlViewer from "@/features/preview/HtmlViewer.vue";

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "out/page.html", name: "page.html", kind: "html", source: "vfs", revision: 0, ...partial };
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  h.readFile.mockReset();
  h.readFile.mockResolvedValue("<html><body><h1>Hi</h1></body></html>");
});

describe("HtmlViewer", () => {
  it("读取中：加载占位", () => {
    h.readFile.mockReturnValue(new Promise(() => {}));
    expect(mount(HtmlViewer, { props: { tab: tab() } }).text()).toContain("读取中");
  });

  it("读取失败：alert + 错误文案", async () => {
    h.readFile.mockRejectedValue(new Error("boom"));
    const wrapper = mount(HtmlViewer, { props: { tab: tab() } });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("读取失败：boom");
  });

  it("渲染态：srcdoc 注入内容，沙箱只留 allow-same-origin 不给脚本", async () => {
    const wrapper = mount(HtmlViewer, { props: { tab: tab() } });
    await flushPromises();

    const frame = wrapper.get('[data-testid="html-viewer-frame"]');
    expect(frame.attributes("srcdoc")).toBe("<html><body><h1>Hi</h1></body></html>");
    expect(frame.attributes("sandbox")).toBe("allow-same-origin");
    expect(frame.attributes("sandbox")).not.toContain("allow-scripts");
  });

  it("切到源码态显示文本编辑器，能切回渲染态", async () => {
    const wrapper = mount(HtmlViewer, { props: { tab: tab() } });
    await flushPromises();

    await wrapper.get('button[aria-label="源码视图"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="text-viewer"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="html-viewer-frame"]').exists()).toBe(false);

    await wrapper.get('button[aria-label="渲染视图"]').trigger("click");
    expect(wrapper.find('[data-testid="html-viewer-frame"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="text-viewer"]').exists()).toBe(false);
  });
});
