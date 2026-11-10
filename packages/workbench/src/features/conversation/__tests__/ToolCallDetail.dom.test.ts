/**
 * 工具细节面板契约：写入内容 / 输出 / 入参要看得见，长内容默认只露前几行，
 * 余量折成「还有 N 行」按钮由用户点开 —— 一次 write 上千行不能直接摊进消息流。
 */

import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ToolCallDetail from "@/features/conversation/ToolCallDetail.vue";
import { i18n } from "@/i18n";
import type { ToolActivityKind, ToolDetail } from "@/types";

function render(detail: ToolDetail, maxLines?: number, meta: { kind?: ToolActivityKind; path?: string; command?: string } = {}) {
  return mount(ToolCallDetail, { props: { detail, maxLines, ...meta }, global: { plugins: [i18n] } });
}

const twelveLines = Array.from({ length: 12 }, (_, index) => `line${index + 1}`).join("\n");

describe("ToolCallDetail", () => {
  it("整文件写入：逐行 + 号展示，给出 +N 统计；超出上限只露前几行并给出剩余行数", () => {
    const wrapper = render({ diff: { path: "src/a.ts", oldText: null, newText: twelveLines } }, 4);
    const text = wrapper.text();
    expect(text).toContain("src/a.ts");
    expect(text).toContain("+line1");
    expect(text).toContain("+line4");
    expect(text).not.toContain("line5");
    expect(wrapper.get('[data-testid="tool-diff-added"]').text()).toBe("+12");
    // 整文件写入没有删除侧
    expect(wrapper.find('[data-testid="tool-diff-removed"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="tool-detail-toggle"]').text()).toContain("还有 8 行");
  });

  it("点开展开全部，再点收起", async () => {
    const wrapper = render({ diff: { path: "src/a.ts", oldText: null, newText: twelveLines } }, 4);
    // 折叠：header + 4 行；展开：header + 12 行
    const rows = () => wrapper.findAll('[data-testid="tool-diff"] > div').length;
    expect(rows()).toBe(5);
    await wrapper.get('[data-testid="tool-detail-toggle"]').trigger("click");
    expect(rows()).toBe(13);

    await wrapper.get('[data-testid="tool-detail-toggle"]').trigger("click");
    expect(rows()).toBe(5);
  });

  it("修改：只标真正增删的行，未变行按上下文保留，并给出 +N/-N", () => {
    const wrapper = render({ diff: { path: "a.ts", oldText: "keep\n旧内容\ntail", newText: "keep\n新内容\ntail" } });
    const text = wrapper.text();
    // 只改中间一行：上下文 keep / tail 各出现一次，且不染色
    expect(text).toContain("旧内容");
    expect(text).toContain("新内容");
    expect(text).toContain("keep");
    expect(text).toContain("tail");
    expect(wrapper.get('[data-testid="tool-diff-added"]').text()).toBe("+1");
    expect(wrapper.get('[data-testid="tool-diff-removed"]').text()).toBe("-1");
    // header + 4 行（context keep / del / add / context tail）；相同行被保留为上下文而非增删
    const rows = wrapper.findAll('[data-testid="tool-diff"] > div');
    expect(rows.length).toBe(5);
    expect(rows.filter((row) => row.text().includes("keep"))[0].text()).not.toMatch(/[+-]keep/);
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

  it("写入：抬头给出动作与文件路径（Wrote path 形态）", () => {
    const wrapper = render({ diff: { path: "src/a.ts", oldText: null, newText: "x" } }, 12, {
      kind: "edit",
      path: "src/a.ts",
    });
    expect(wrapper.get('[data-testid="tool-detail-action"]').text()).toBe("写入");
    expect(wrapper.get('[data-testid="tool-diff"]').text()).toContain("src/a.ts");
  });

  it("修改：抬头是「修改」而不是「写入」", () => {
    const wrapper = render({ diff: { path: "a.ts", oldText: "a", newText: "b" } }, 12, { kind: "edit" });
    expect(wrapper.get('[data-testid="tool-detail-action"]').text()).toBe("修改");
  });

  it("命令：以 $ 起头单独成块，输出从 1 起编行号", () => {
    const wrapper = render({ text: "first\nsecond" }, 12, { kind: "execute", command: "pnpm test" });
    const command = wrapper.get('[data-testid="tool-command"]');
    expect(command.text()).toContain("$");
    expect(command.text()).toContain("pnpm test");

    const lines = wrapper.get('[data-testid="tool-output"]').findAll('[data-testid="tool-code-line"]');
    expect(lines).toHaveLength(2);
    expect(lines[0].text()).toBe("1first");
    expect(lines[1].text()).toBe("2second");
    expect(wrapper.get('[data-testid="tool-output-count"]').text()).toBe("2 行");
  });

  it("读取：输出抬头带上被读文件路径，别让「输出」变成无主内容", () => {
    const wrapper = render({ text: "export {}" }, 12, { kind: "read", path: "src/b.ts" });
    expect(wrapper.get('[data-testid="tool-output-path"]').text()).toBe("src/b.ts");
    expect(wrapper.get('[data-testid="tool-output"]').text()).toContain("读取");
  });

  it("JSON 输出嗅探后着色（语言包异步加载完成前退回纯文本）", async () => {
    const wrapper = render({ text: '{"count":1}' }, 12, { kind: "execute", command: "cat a.json" });
    await flushPromises();
    // 语言包是动态 import，首次加载要多等一两个任务周期。
    await vi.waitFor(() => expect(wrapper.get('[data-testid="tool-output"]').html()).toContain("text-amber"));
  });

  it("多行命令也逐行给出行号槽：首行 $，续行留空", () => {
    const wrapper = render({}, 12, { kind: "execute", command: "cd app\npnpm test" });
    const lines = wrapper.get('[data-testid="tool-command"]').findAll('[data-testid="tool-code-line"]');
    expect(lines).toHaveLength(2);
    expect(lines[0].text()).toContain("$");
    expect(lines[1].text()).not.toContain("$");
  });
});
