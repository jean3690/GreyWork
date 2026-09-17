import { flushPromises, mount, type DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MarkdownText from "@/features/shared/MarkdownText.vue";

// 真实 mermaid 在 happy-dom 内做测量/布局不可靠，且会拖慢套件；渲染门面在此 mock，
// 组件只测分派、状态机与降级（真实渲染在浏览器 dev 下人工验证）。
vi.mock("@/lib/mermaid", () => ({
  renderMermaid: vi.fn(),
}));
import { renderMermaid } from "@/lib/mermaid";
import { applyAppearance } from "@/lib/theme";

const mockRender = vi.mocked(renderMermaid);

/** 切外观要走真实入口：只改 data-theme 是不会广播的，组件收不到。 */
function setColorMode(colorMode: "dark" | "light" | "system"): void {
  applyAppearance({ palette: "greywork", colorMode, fontSize: "medium" });
}

const SOURCE = "flowchart LR\n  A[解析] --> B{渲染}";
const MARKDOWN = `上文\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\n下文`;

/** mock svg 自带 mermaid 同款内联 max-width（自然宽），供宽度归一化与缩放断言。 */
function svgOf(label: string): string {
  return `<svg data-mermaid="${label}" viewBox="0 0 400 100" style="max-width: 400px"><text>${label}</text></svg>`;
}

/** 每个用例的挂载件：订阅挂在 window 上，跨用例不卸会互相触发重渲。 */
const wrappers: VueWrapper[] = [];

beforeEach(() => {
  setColorMode("light");
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  delete document.documentElement.dataset.theme;
  mockRender.mockReset();
});

function mountMarkdown(content: string): VueWrapper {
  const wrapper = mount(MarkdownText, { props: { content } });
  wrappers.push(wrapper);
  return wrapper;
}

/** 渲染出的图 svg 是宿主的直系子节点；头部缩放按钮是 lucide 图标 svg，不能混入。 */
function diagramSvg(wrapper: VueWrapper): DOMWrapper<Element> {
  return wrapper.find(".md-mermaid__host > svg");
}

describe("MarkdownText · mermaid 围栏分派", () => {
  it("mermaid 围栏交给 MermaidBlock 并插入渲染出的 svg，不落原文代码块", async () => {
    mockRender.mockResolvedValue({ svg: svgOf("ok") });
    const wrapper = mountMarkdown(MARKDOWN);
    await flushPromises();

    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockRender).toHaveBeenCalledWith(SOURCE, false);
    const diagram = diagramSvg(wrapper);
    expect(diagram.exists()).toBe(true);
    expect(diagram.attributes("data-mermaid")).toBe("ok");
    // 原文不应以代码块形态再出现一次
    expect(wrapper.find(".md-code").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("```mermaid");
  });

  it("缩放按钮按自然宽步进 ±25%，重置回 100%", async () => {
    mockRender.mockResolvedValue({ svg: svgOf("zoom") });
    const wrapper = mountMarkdown(MARKDOWN);
    await flushPromises();

    const svg = () => diagramSvg(wrapper);
    expect(svg().attributes("width")).toBe("400px");
    expect(wrapper.text()).toContain("100%");

    await wrapper.find('button[aria-label="放大"]').trigger("click");
    expect(svg().attributes("width")).toBe("500px");
    expect(wrapper.text()).toContain("125%");

    await wrapper.find('button[aria-label="放大"]').trigger("click");
    expect(svg().attributes("width")).toBe("600px");

    await wrapper.find('button[aria-label="缩小"]').trigger("click");
    expect(svg().attributes("width")).toBe("500px");

    await wrapper.find('button[aria-label="重置缩放"]').trigger("click");
    expect(svg().attributes("width")).toBe("400px");
    expect(wrapper.text()).toContain("100%");
  });

  it("缩放钳制在 0.5×–3×，边界按钮禁用", async () => {
    mockRender.mockResolvedValue({ svg: svgOf("clamp") });
    const wrapper = mountMarkdown(MARKDOWN);
    await flushPromises();

    const svg = () => diagramSvg(wrapper);
    const zoomOut = wrapper.find('button[aria-label="缩小"]');
    const zoomIn = wrapper.find('button[aria-label="放大"]');
    expect(zoomOut.attributes("disabled")).toBeUndefined();

    for (let i = 0; i < 20; i++) await zoomOut.trigger("click");
    expect(svg().attributes("width")).toBe("200px"); // 400 × 0.5
    expect(zoomOut.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("50%");

    for (let i = 0; i < 20; i++) await zoomIn.trigger("click");
    expect(svg().attributes("width")).toBe("1200px"); // 400 × 3.0
    expect(zoomIn.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("300%");
  });

  it("深色外观时以 dark 主题渲染", async () => {
    setColorMode("dark");
    mockRender.mockResolvedValue({ svg: svgOf("dark") });
    mountMarkdown(MARKDOWN);
    await flushPromises();

    expect(mockRender).toHaveBeenCalledWith(SOURCE, true);
  });

  it("渲染失败降级为原文代码块并展示原因（不产生 svg）", async () => {
    mockRender.mockRejectedValue(new Error("Parse error on line 2: unexpected token"));
    const wrapper = mountMarkdown(MARKDOWN);
    await flushPromises();

    expect(wrapper.find(".md-mermaid svg").exists()).toBe(false);
    const fallback = wrapper.find(".md-mermaid__fallback");
    expect(fallback.exists()).toBe(true);
    expect(fallback.text()).toContain("Parse error on line 2");
    // 原文完整保留（走文本插值），可再复制
    expect(fallback.find("pre").text()).toBe(SOURCE);
  });

  it("宿主主题翻转触发按新外观重渲", async () => {
    mockRender.mockResolvedValueOnce({ svg: svgOf("light") });
    const wrapper = mountMarkdown(MARKDOWN);
    await flushPromises();
    expect(mockRender).toHaveBeenLastCalledWith(SOURCE, false);

    mockRender.mockResolvedValueOnce({ svg: svgOf("switched") });
    setColorMode("dark");
    await vi.waitFor(() => expect(mockRender).toHaveBeenCalledTimes(2));
    await flushPromises();

    expect(mockRender).toHaveBeenLastCalledWith(SOURCE, true);
    const diagram = diagramSvg(wrapper);
    expect(diagram.attributes("data-mermaid")).toBe("switched");
  });

  it("同一消息多个 mermaid 围栏各自成图，非 mermaid 围栏仍走代码块", async () => {
    mockRender.mockResolvedValue({ svg: svgOf("n") });
    const wrapper = mountMarkdown(
      [
        "```mermaid",
        "flowchart LR",
        "  a --> b",
        "```",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "```mermaid",
        "sequenceDiagram",
        "  A->>B: hi",
        "```",
      ].join("\n"),
    );
    await flushPromises();

    expect(mockRender).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll(".md-mermaid").length).toBe(2);
    expect(wrapper.findAll(".md-mermaid__host > svg").length).toBe(2);
    const codeBlocks = wrapper.findAll(".md-code");
    expect(codeBlocks.length).toBe(1);
    expect(codeBlocks[0].text()).toContain("const x = 1;");
  });
});
