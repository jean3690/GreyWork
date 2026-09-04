// 渲染层用例：解析逻辑在 lib/markdown.test.ts 覆盖，这里只验「块 → DOM 语义标签」的落地，
// 尤其是 h1–h6 层级、ul/ol 真实嵌套、表格对齐与 v-html 缺席（注入防线）。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import MarkdownText from "@/components/MarkdownText.vue";

function render(content: string) {
  return mount(MarkdownText, { props: { content } });
}

describe("MarkdownText · 标题", () => {
  it("# 渲染为 h1，## 为 h2，层级不塌成 p", () => {
    const wrapper = render("# 一级\n## 二级\n### 三级");
    expect(wrapper.find("h1").text()).toBe("一级");
    expect(wrapper.find("h2").text()).toBe("二级");
    expect(wrapper.find("h3").text()).toBe("三级");
    expect(wrapper.findAll("p")).toHaveLength(0);
  });
});

describe("MarkdownText · 列表", () => {
  it("嵌套无序列表渲染为真实 ul 套 ul", () => {
    const wrapper = render("- a\n  - a1");
    const outer = wrapper.find("ul");
    expect(outer.exists()).toBe(true);
    expect(outer.find("li ul li").text()).toBe("a1");
  });

  it("有序列表带 start，且有序项下可嵌 ul", () => {
    const wrapper = render("2. step\n   - detail");
    const ol = wrapper.find("ol");
    expect(ol.attributes("start")).toBe("2");
    expect(ol.find("li ul li").text()).toBe("detail");
  });
});

describe("MarkdownText · 表格", () => {
  it("表头进 th 并带 scope，对齐落到 style", () => {
    const wrapper = render("| 左 | 右 |\n| :-- | --: |\n| 1 | 2 |");
    const th = wrapper.findAll("th");
    expect(th).toHaveLength(2);
    expect(th[0].attributes("scope")).toBe("col");
    expect(th[1].attributes("style")).toContain("right");
    expect(wrapper.findAll("tbody td").map((td) => td.text())).toEqual(["1", "2"]);
  });
});

describe("MarkdownText · 行内与块级其余类型", () => {
  it("code / bold / italic / strike / link 各归其位", () => {
    const wrapper = render("`c` **b** *i* ~~s~~ [l](https://a.com)");
    expect(wrapper.find("code").text()).toBe("c");
    expect(wrapper.find("strong").text()).toBe("b");
    expect(wrapper.find("em").text()).toBe("i");
    expect(wrapper.find("del").text()).toBe("s");
    const link = wrapper.find("a");
    expect(link.attributes("href")).toBe("https://a.com");
    expect(link.attributes("rel")).toContain("noopener");
  });

  it("引用与分割线", () => {
    const wrapper = render("> quoted\n\n---");
    expect(wrapper.find("blockquote").text()).toBe("quoted");
    expect(wrapper.find("hr").exists()).toBe(true);
  });

  it("围栏代码块展示路径标签、行号与复制按钮", () => {
    const wrapper = render("```ts src/main.ts\nline1\nline2\n```");
    expect(wrapper.find(".md-code__path").text()).toBe("src/main.ts");
    expect(wrapper.findAll(".md-code__lines span").map((s) => s.text())).toEqual(["1", "2"]);
    expect(wrapper.find(".md-code__copy").exists()).toBe(true);
    expect(wrapper.find("pre code").text()).toBe("line1\nline2");
  });

  it("段落内换行渲染为 br 而非合并成一行", () => {
    const wrapper = render("l1\nl2");
    expect(wrapper.findAll("p")).toHaveLength(1);
    expect(wrapper.findAll("p br")).toHaveLength(1);
  });
});

describe("MarkdownText · 注入防线", () => {
  it("裸 HTML 作为文本输出，不产生真实元素", () => {
    const wrapper = render("<img src=x onerror=alert(1)> 与 <b>bold</b>");
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.find("b").exists()).toBe(false);
    expect(wrapper.text()).toContain("<img src=x onerror=alert(1)>");
  });

  it("javascript: 链接不渲染为 a", () => {
    const wrapper = render("[x](javascript:alert(1))");
    expect(wrapper.find("a").exists()).toBe(false);
  });

  it("代码块内的标记不被解析", () => {
    const wrapper = render("```\n# not heading\n- not list\n```");
    expect(wrapper.find("h1").exists()).toBe(false);
    expect(wrapper.find("ul").exists()).toBe(false);
  });
});
