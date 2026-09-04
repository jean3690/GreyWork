/**
 * 工具细节面板契约：写入内容 / 输出 / 入参要看得见，长内容默认只露前几行，
 * 余量折成「还有 N 行」按钮由用户点开 —— 一次 write 上千行不能直接摊进消息流。
 */

import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ToolCallDetail from "@/components/chat/ToolCallDetail.vue";
import { i18n } from "@/i18n";
import type { ToolDetail } from "@/types";

function render(detail: ToolDetail, maxLines?: number) {
  return mount(ToolCallDetail, { props: { detail, maxLines }, global: { plugins: [i18n] } });
}

const twelveLines = Array.from({ length: 12 }, (_, index) => `line${index + 1}`).join("\n");

describe("ToolCallDetail", () => {
  it("整文件写入：逐行 + 号展示，超出上限只露前几行并给出剩余行数", () => {
    const wrapper = render({ diff: { path: "src/a.ts", oldText: null, newText: twelveLines } }, 4);
    const text = wrapper.text();
    expect(text).toContain("src/a.ts");
    expect(text).toContain("+ line1");
    expect(text).toContain("+ line4");
    expect(text).not.toContain("line5");
    expect(wrapper.get('[data-testid="tool-detail-toggle"]').text()).toContain("还有 8 行");
  });

  it("点开展开全部，再点收起", async () => {
    const wrapper = render({ diff: { path: "src/a.ts", oldText: null, newText: twelveLines } }, 4);
    await wrapper.get('[data-testid="tool-detail-toggle"]').trigger("click");
    expect(wrapper.text()).toContain("+ line12");

    await wrapper.get('[data-testid="tool-detail-toggle"]').trigger("click");
    expect(wrapper.text()).not.toContain("line12");
  });

  it("修改：旧行 -、新行 + 同屏对照", () => {
    const wrapper = render({ diff: { path: "a.ts", oldText: "旧内容", newText: "新内容" } });
    expect(wrapper.text()).toContain("- 旧内容");
    expect(wrapper.text()).toContain("+ 新内容");
  });

  it("输出与入参分区展示（MCP 调用主要靠入参说明干了什么）", () => {
    const wrapper = render({ text: "答案正文", args: '{\n  "repoName": "a/b"\n}' });
    expect(wrapper.text()).toContain("输出");
    expect(wrapper.text()).toContain("答案正文");
    expect(wrapper.text()).toContain("入参");
    expect(wrapper.text()).toContain('"repoName": "a/b"');
  });

  it("内容不长时不出展开按钮", () => {
    const wrapper = render({ text: "一行输出" });
    expect(wrapper.find('[data-testid="tool-detail-toggle"]').exists()).toBe(false);
  });

  it("源内容被截断时明示，不假装完整", () => {
    const wrapper = render({ text: "前 8000 字…", clipped: true });
    expect(wrapper.text()).toContain("已截断");
  });

  it("终端型工具说明输出走终端通道", () => {
    const wrapper = render({ terminalId: "term-9" });
    expect(wrapper.text()).toContain("term-9");
  });
});
