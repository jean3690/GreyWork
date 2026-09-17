/**
 * docx 块渲染给划词层留的语义属性。
 *
 * 这几个属性是「一套通用选区解析」能同时吃下 docx 与 markdown 的前提：docx 的标题
 * 与正文都是 `<p>`，列表项也不是 `<li>`，层级只存在于解析模型里。不写出来，
 * 划词层就只能看到「一个段落」，来源面包屑与角色标签全都会退化。
 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DocxBlocks from "@/features/preview/DocxBlocks.vue";
import type { DocxBlock, DocxParagraph, DocxRun } from "@/lib/docx-parse";

function run(text: string): DocxRun {
  return {
    text,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    sizePt: null,
    color: null,
    highlight: null,
    font: null,
    vertAlign: null,
    image: null,
    link: null,
  };
}

function paragraph(overrides: Partial<DocxParagraph> = {}): DocxParagraph {
  return {
    kind: "paragraph",
    runs: [run("文字")],
    align: null,
    heading: null,
    indent: 0,
    list: null,
    spaceBefore: 0,
    spaceAfter: 0,
    ...overrides,
  };
}

function mountBlocks(blocks: DocxBlock[]) {
  return mount(DocxBlocks, { props: { blocks }, attachTo: document.body });
}

describe("DocxBlocks 的选区语义属性", () => {
  it("标题段落带 data-heading，层级来自模型", () => {
    const wrapper = mountBlocks([paragraph({ heading: 2 })]);
    expect(wrapper.get('[data-testid="docx-paragraph"]').attributes("data-heading")).toBe("2");
    wrapper.unmount();
  });

  it("正文段落没有 data-heading（不能凭空长出标题语义）", () => {
    const wrapper = mountBlocks([paragraph()]);
    expect(wrapper.get('[data-testid="docx-paragraph"]').attributes("data-heading")).toBeUndefined();
    wrapper.unmount();
  });

  it("列表段落带 data-list-level", () => {
    const wrapper = mountBlocks([paragraph({ list: { marker: "•", level: 1, ordered: false } })]);
    expect(wrapper.get('[data-testid="docx-paragraph"]').attributes("data-list-level")).toBe("1");
    wrapper.unmount();
  });

  it('0 级列表也要写出来：data-list-level="0" 与「不是列表」必须能区分', () => {
    const wrapper = mountBlocks([paragraph({ list: { marker: "1.", level: 0, ordered: true } })]);
    expect(wrapper.get('[data-testid="docx-paragraph"]').attributes("data-list-level")).toBe("0");
    wrapper.unmount();
  });

  it("表格单元格里的段落同样带语义属性（递归渲染不丢）", () => {
    const wrapper = mountBlocks([
      {
        kind: "table",
        rows: [{ cells: [{ blocks: [paragraph({ heading: 3 })], colSpan: 1, covered: false, rowSpan: 1, fill: null, width: null }] }],
        colWidths: [100],
      },
    ]);
    expect(wrapper.get("td [data-testid='docx-paragraph']").attributes("data-heading")).toBe("3");
    wrapper.unmount();
  });
});
