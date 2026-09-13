// 网页正文预览：渲染缓存正文；缓存缺失时自抓；「发送到对话」经事件总线发出正文。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked((await import("@tauri-apps/api/core")).invoke);

import WebPageViewer from "@/components/preview/WebPageViewer.vue";
import { clearWebArticleCache, fetchArticle } from "@/lib/web-fetch";
import { appEvents } from "@/events";
import type { PreviewTab } from "@/stores/preview";

function webTab(path: string): PreviewTab {
  return { id: "pv-web", path, name: "article", kind: "web", source: "web", revision: 0 };
}

function stubHostHtml(html: string, finalUrl = "https://example.com/"): void {
  invokeMock.mockResolvedValue({ finalUrl, status: 200, contentType: "text/html", html });
}

const ARTICLE_HTML = "<html><head><title>标题</title></head><body><article><p>正文段落</p></article></body></html>";

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  clearWebArticleCache();
  invokeMock.mockReset();
  setActivePinia(createPinia());
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("WebPageViewer", () => {
  it("渲染缓存里的标题与正文", async () => {
    stubHostHtml(ARTICLE_HTML);
    await fetchArticle("https://example.com/");
    const wrapper = mount(WebPageViewer, { props: { tab: webTab("https://example.com/") } });

    expect(wrapper.text()).toContain("标题");
    expect(wrapper.text()).toContain("正文段落");
    wrapper.unmount();
  });

  it("点「发送到对话」发出 chat:attachText（标题 + 正文）", async () => {
    stubHostHtml(ARTICLE_HTML);
    await fetchArticle("https://example.com/");
    const wrapper = mount(WebPageViewer, { props: { tab: webTab("https://example.com/") } });

    const received: unknown[] = [];
    const dispose = appEvents.on("chat:attachText", (payload) => received.push(payload));
    await wrapper.get('[data-testid="web-send-to-chat"]').trigger("click");
    dispose();

    expect(received).toEqual([{ name: "标题", text: expect.stringContaining("正文段落"), mime: "text/markdown" }]);
    wrapper.unmount();
  });

  it("缓存缺失时自行抓取并显示", async () => {
    stubHostHtml(ARTICLE_HTML);
    const wrapper = mount(WebPageViewer, { props: { tab: webTab("https://example.com/") } });

    await vi.waitFor(() => expect(wrapper.text()).toContain("正文段落"));
    expect(invokeMock).toHaveBeenCalledWith("web_fetch", { request: { url: "https://example.com/" } });
    wrapper.unmount();
  });
});
