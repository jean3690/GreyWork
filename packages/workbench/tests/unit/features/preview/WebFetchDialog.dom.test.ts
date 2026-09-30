/**
 * 抓取网页对话框（features/preview/WebFetchDialog）：
 *
 * - 正文 / 浏览器两种模式共用一个 URL 输入，提交分流是核心契约；
 * - 正文模式失败要留在对话框里给 error，不 emit close；
 * - 浏览器模式不走抓取，直接 preview.openBrowser + close；
 * - 非桌面态（子 webview 不存在）浏览器选项禁用并带 title 说明。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";

const h = vi.hoisted(() => ({
  browserSupported: true,
  fetchArticle: vi.fn<() => Promise<unknown>>(),
  preview: { open: vi.fn(), openBrowser: vi.fn() },
}));

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup:
        (_, { slots }) =>
        () =>
          h("div", slots.default?.()),
    });
  return {
    Dialog: passthrough("Dialog"),
    DialogContent: passthrough("DialogContent"),
    DialogDescription: passthrough("DialogDescription"),
    DialogTitle: passthrough("DialogTitle"),
  };
});

vi.mock("@/lib/web-fetch", () => ({
  // 归一化规则在 browser-backend / web-fetch 各自的单测里钉，这里只验证分流。
  normalizeUrl: (value: string) => value.trim(),
  fetchArticle: h.fetchArticle,
}));

vi.mock("@/lib/web-fetch-backend", () => ({
  webFetchBackend: { supported: () => true },
}));

vi.mock("@/lib/browser-backend", () => ({
  browserBackend: { supported: () => h.browserSupported },
}));

vi.mock("@/stores/preview", () => ({
  usePreviewStore: () => h.preview,
}));

import { i18n } from "@/i18n";
import WebFetchDialog from "@/features/preview/WebFetchDialog.vue";

const mounted: VueWrapper[] = [];

beforeEach(() => {
  h.browserSupported = true;
  h.fetchArticle.mockReset();
  h.preview.open.mockReset();
  h.preview.openBrowser.mockReset();
  i18n.global.locale.value = "zh-CN";
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

function render(): VueWrapper {
  const wrapper = mount(WebFetchDialog, { global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

async function fillAndSubmit(wrapper: VueWrapper, url: string): Promise<void> {
  await wrapper.find('[data-testid="web-fetch-url"]').setValue(url);
  await wrapper.find('[data-testid="web-fetch-submit"]').trigger("submit");
  await flushPromises();
}

describe("WebFetchDialog", () => {
  it("默认正文模式：抓正文 → open 阅读版 tab → close", async () => {
    h.fetchArticle.mockResolvedValue({ url: "https://example.com/a", title: "A" });
    const wrapper = render();
    await fillAndSubmit(wrapper, "  example.com/a  ");

    expect(h.fetchArticle).toHaveBeenCalledWith("example.com/a");
    expect(h.preview.open).toHaveBeenCalledWith("https://example.com/a", "A", "web", "web");
    expect(h.preview.openBrowser).not.toHaveBeenCalled();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("正文模式失败：显示 error 并留在对话框", async () => {
    h.fetchArticle.mockRejectedValue(new Error("超时"));
    const wrapper = render();
    await fillAndSubmit(wrapper, "example.com/a");

    expect(wrapper.find('[role="alert"]').text()).toContain("超时");
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("浏览器模式：不走抓取，openBrowser + close，提交文案是「打开」", async () => {
    const wrapper = render();
    await wrapper.find('[data-testid="web-fetch-mode-browser"]').trigger("click");
    expect(wrapper.text()).toContain(i18n.global.t("web.browserHint"));
    expect(wrapper.find('[data-testid="web-fetch-submit"]').text()).toBe(i18n.global.t("web.open"));

    await fillAndSubmit(wrapper, "example.com/a");
    expect(h.fetchArticle).not.toHaveBeenCalled();
    expect(h.preview.openBrowser).toHaveBeenCalledWith("example.com/a");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("非桌面态：浏览器选项禁用并带 title 说明", () => {
    h.browserSupported = false;
    const wrapper = render();
    const segment = wrapper.find('[data-testid="web-fetch-mode-browser"]');
    expect(segment.attributes("disabled")).toBeDefined();
    expect(segment.attributes("title")).toBe(i18n.global.t("web.browserUnsupported"));
  });

  it("空 URL：提交按钮禁用", () => {
    const wrapper = render();
    expect(wrapper.find('[data-testid="web-fetch-submit"]').attributes("disabled")).toBeDefined();
  });
});
