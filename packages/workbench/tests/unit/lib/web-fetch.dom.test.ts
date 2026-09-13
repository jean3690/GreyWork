// 网页正文提取契约：选根（article / main / 最大文本块）、标题回退、脚本样式剔除、
// URL 归一化；以及 fetchArticle 经宿主抓取后写缓存（mock invoke）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked((await import("@tauri-apps/api/core")).invoke);

import { clearWebArticleCache, extractReadable, fetchArticle, getCachedArticle, normalizeUrl } from "@/lib/web-fetch";

beforeEach(() => {
  // DOMParser 来自真实 window，这里只补 Tauri 运行时标记（不能用 stubGlobal 换掉 window）
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  clearWebArticleCache();
  invokeMock.mockReset();
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("web-fetch · normalizeUrl", () => {
  it("缺 scheme 补 https://，去首尾空白，空串保持空串", () => {
    expect(normalizeUrl("  example.com/a ")).toBe("https://example.com/a");
    expect(normalizeUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(normalizeUrl("")).toBe("");
  });
});

describe("web-fetch · extractReadable", () => {
  it("优先取 article，剔除脚本/样式/导航/页脚", () => {
    const html = `
      <html><head>
        <title>页面标题</title>
        <meta property="og:title" content="OG 标题" />
        <script>console.log('x')</script>
        <style>.a { color: red }</style>
      </head><body>
        <nav>站内导航</nav>
        <article><h1>正文标题</h1><p>第一段。</p><p>第二段。</p></article>
        <footer>版权页脚</footer>
      </body></html>`;
    const { title, text } = extractReadable(html, "https://example.com/");
    expect(title).toBe("OG 标题");
    expect(text).toContain("第一段。");
    expect(text).toContain("第二段。");
    expect(text).not.toContain("站内导航");
    expect(text).not.toContain("版权页脚");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("color: red");
  });

  it("无 article 时取 main；标题回退 h1", () => {
    const { title, text } = extractReadable("<html><body><main><h1>H1 标题</h1><p>内容</p></main></body></html>", "https://example.com/");
    expect(title).toBe("H1 标题");
    expect(text).toContain("内容");
  });

  it("无 article/main 时取文本量最大的块（不含 body 全量）", () => {
    const html = `<html><body>
      <div id="a"><p>短</p></div>
      <div id="b"><p>这是一段明显更长的正文内容，应该被选中。</p><p>再加一段。</p></div>
    </body></html>`;
    const { text } = extractReadable(html, "https://example.com/");
    expect(text).toContain("这是一段明显更长的正文内容");
    expect(text).not.toContain("短");
  });

  it("无任何标题时回退到 url", () => {
    const { title } = extractReadable("<html><body><p>x</p></body></html>", "https://example.com/x");
    expect(title).toBe("https://example.com/x");
  });
});

describe("web-fetch · fetchArticle", () => {
  it("经宿主抓取 → 提取 → 按归一化 URL 写缓存", async () => {
    invokeMock.mockResolvedValue({
      finalUrl: "https://example.com/final",
      status: 200,
      contentType: "text/html",
      html: "<html><head><title>T</title></head><body><article><p>正文</p></article></body></html>",
    });

    const article = await fetchArticle("example.com/a");

    expect(invokeMock).toHaveBeenCalledWith("web_fetch", { request: { url: "https://example.com/a" } });
    expect(article.title).toBe("T");
    expect(article.text).toContain("正文");
    expect(getCachedArticle("https://example.com/a")?.text).toContain("正文");
  });

  it("空 URL 直接报错，不发起请求", async () => {
    await expect(fetchArticle("   ")).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
