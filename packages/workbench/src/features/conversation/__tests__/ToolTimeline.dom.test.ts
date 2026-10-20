/**
 * 工具时间线渲染契约：agent 调工具时消息里必须看得见「调了什么」，
 * MCP 调用还要看得见「是哪台外部服务器」——折叠态也不能藏起来。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ToolTimeline from "@/features/conversation/ToolTimeline.vue";
import { i18n } from "@/i18n";
import type { ToolActivity } from "@/types";

const T = 1_700_000_000_000;

function act(partial: Partial<ToolActivity> & { toolCallId: string }): ToolActivity {
  return { kind: "read", status: "completed", startedAt: T, finishedAt: T + 120, ...partial };
}

function render(activities: ToolActivity[]) {
  return mount(ToolTimeline, { props: { activities }, global: { plugins: [i18n] } });
}

describe("ToolTimeline", () => {
  it("有调用在飞行中：自动展开并逐行列出", () => {
    const wrapper = render([
      act({ toolCallId: "a", kind: "read", path: "src/main.ts" }),
      act({ toolCallId: "b", kind: "execute", command: "pnpm test", status: "in_progress", finishedAt: null }),
    ]);
    expect(wrapper.get('[data-testid="tool-timeline"]').attributes("data-open")).toBe("true");
    expect(wrapper.findAll('[data-testid="tool-row"]')).toHaveLength(2);
    expect(wrapper.text()).toContain("pnpm test");
    expect(wrapper.text()).toContain("src/main.ts");
  });

  it("全部结算：折叠为一行摘要，点击头部可展开", async () => {
    const wrapper = render([act({ toolCallId: "a", kind: "read", path: "a.ts" })]);
    expect(wrapper.findAll('[data-testid="tool-row"]')).toHaveLength(0);
    expect(wrapper.text()).toContain("Read 1");

    await wrapper.get("button").trigger("click");
    expect(wrapper.findAll('[data-testid="tool-row"]')).toHaveLength(1);
  });

  it("MCP 调用：折叠态标出服务器，展开行带服务器与工具名", async () => {
    const wrapper = render([
      act({ toolCallId: "m1", kind: "other", mcpServer: "deepwiki", name: "ask_question", description: "ask_question" }),
    ]);
    const badges = wrapper.findAll('[data-testid="tool-mcp-badge"]');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.text()).toContain("MCP · deepwiki");

    await wrapper.get("button").trigger("click");
    const row = wrapper.get('[data-testid="tool-row"]');
    expect(row.attributes("data-mcp-server")).toBe("deepwiki");
    expect(row.text()).toContain("deepwiki");
    expect(row.text()).toContain("ask_question");
  });

  it("同一台服务器多次调用只出一个徽标", () => {
    const wrapper = render([
      act({ toolCallId: "m1", kind: "other", mcpServer: "deepwiki", name: "read_wiki_structure", description: "read_wiki_structure" }),
      act({ toolCallId: "m2", kind: "other", mcpServer: "deepwiki", name: "ask_question", description: "ask_question" }),
    ]);
    expect(wrapper.findAll('[data-testid="tool-mcp-badge"]')).toHaveLength(1);
  });

  it("非 MCP 调用不挂 MCP 徽标", () => {
    const wrapper = render([act({ toolCallId: "a", kind: "read", path: "a.ts" })]);
    expect(wrapper.findAll('[data-testid="tool-mcp-badge"]')).toHaveLength(0);
  });

  it("失败调用展开后给出原因", async () => {
    const wrapper = render([
      act({ toolCallId: "f1", kind: "other", status: "failed", mcpServer: "deepwiki", name: "ask_question", error: "404 repo not found" }),
    ]);
    await wrapper.get("button").trigger("click");
    expect(wrapper.text()).toContain("404 repo not found");
  });

  it("从运行中转为结算后自动收起", async () => {
    const running = act({ toolCallId: "a", kind: "execute", command: "pnpm build", status: "in_progress", finishedAt: null });
    const wrapper = render([running]);
    expect(wrapper.get('[data-testid="tool-timeline"]').attributes("data-open")).toBe("true");

    await wrapper.setProps({ activities: [{ ...running, status: "completed", finishedAt: T + 300 }] });
    expect(wrapper.get('[data-testid="tool-timeline"]').attributes("data-open")).toBe("false");
  });

  it("有细节的行可点开：就地展示写入内容", async () => {
    const wrapper = render([
      act({
        toolCallId: "w1",
        kind: "edit",
        path: "src/a.ts",
        detail: { diff: { path: "src/a.ts", oldText: null, newText: "第一行\n第二行" } },
      }),
    ]);
    await wrapper.get("button").trigger("click");
    expect(wrapper.find('[data-testid="tool-detail"]').exists()).toBe(false);

    await wrapper.get('[data-testid="tool-row-toggle"]').trigger("click");
    const detail = wrapper.get('[data-testid="tool-detail"]');
    expect(detail.text()).toContain("+第一行");
    expect(detail.text()).toContain("+第二行");
  });

  it("没有细节的行不做成按钮（点了也没东西可看）", async () => {
    const wrapper = render([act({ toolCallId: "r1", kind: "read", path: "a.ts" })]);
    await wrapper.get("button").trigger("click");
    expect(wrapper.find('[data-testid="tool-row-toggle"]').exists()).toBe(false);
  });

  it("运行中显示已结算/总量进度（3/7 式）与进度条", () => {
    const wrapper = render([
      act({ toolCallId: "a", kind: "read", path: "a.ts" }),
      act({ toolCallId: "b", kind: "read", path: "b.ts" }),
      act({ toolCallId: "c", kind: "execute", command: "pnpm test", status: "in_progress", finishedAt: null }),
    ]);
    expect(wrapper.get('[data-testid="tool-progress"]').text()).toBe("2/3");
    const bar = wrapper.get('[data-testid="tool-progressbar"] > div');
    expect(bar.attributes("style")).toContain("width: 67%");
  });

  it("结算后进度条消失", () => {
    const wrapper = render([act({ toolCallId: "a", kind: "read", path: "a.ts" })]);
    expect(wrapper.find('[data-testid="tool-progressbar"]').exists()).toBe(false);
  });

  it("改动类调用标出 +N/-N（行内与头部汇总）", async () => {
    const wrapper = render([
      act({
        toolCallId: "e1",
        kind: "edit",
        path: "src/a.ts",
        detail: { diff: { path: "src/a.ts", oldText: "old\ntail", newText: "new\ntail\nmore" } },
      }),
    ]);
    expect(wrapper.get('[data-testid="tool-change-stat"]').text()).toContain("+2");
    expect(wrapper.get('[data-testid="tool-change-stat"]').text()).toContain("-1");

    await wrapper.get("button").trigger("click");
    expect(wrapper.get('[data-testid="tool-row-added"]').text()).toBe("+2");
    expect(wrapper.get('[data-testid="tool-row-removed"]').text()).toBe("-1");
  });

  it("read 之类不改文件的调用不标改动量", async () => {
    const wrapper = render([
      act({ toolCallId: "r1", kind: "read", path: "a.ts", detail: { diff: { path: "a.ts", oldText: null, newText: "x" } } }),
    ]);
    expect(wrapper.find('[data-testid="tool-change-stat"]').exists()).toBe(false);
  });

  it("运行中：头部进度旁显示实时总跨度，秒表推进读数跟着走", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T + 1000);
    const wrapper = render([act({ toolCallId: "a", kind: "read", path: "a.ts", status: "in_progress", finishedAt: null, startedAt: T })]);
    // 进度数字与实时跨度并存：一个答「还剩几个」，一个答「已经跑了多久」
    expect(wrapper.get('[data-testid="tool-progress"]').text()).toBe("0/1");
    expect(wrapper.get('[data-testid="tool-span"]').text()).toBe("1.0s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get('[data-testid="tool-span"]').text()).toBe("2.0s");
  });

  it("飞行中的行也显示实时耗时（不再是只有结算后才有时读数）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T + 2000);
    const wrapper = render([
      act({ toolCallId: "b", kind: "execute", command: "pnpm test", status: "in_progress", finishedAt: null, startedAt: T + 500 }),
    ]);
    // 运行中自动展开，行内直接可见
    expect(wrapper.get('[data-testid="tool-row-duration"]').text()).toBe("1.5s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get('[data-testid="tool-row-duration"]').text()).toBe("2.5s");
  });

  it("结算后折叠头瘦身：一条安静的工具日志行（无标题、无完成徽标）", () => {
    const wrapper = render([act({ toolCallId: "a", kind: "read", path: "a.ts" })]);
    const text = wrapper.get('[data-testid="tool-timeline"]').text();
    expect(text).toContain("Read 1");
    expect(text).not.toContain("完成");
    expect(text).not.toContain("工具");
  });

  it("失败仍保留状态徽标（失败必须被看见，不能跟着一起瘦掉）", () => {
    const wrapper = render([act({ toolCallId: "f1", kind: "read", path: "a.ts", status: "failed", error: "boom" })]);
    expect(wrapper.get('[data-testid="tool-timeline"]').text()).toContain("失败");
  });

  it("调用落定时播报一句（完成/失败 + 对象）；历史批量挂载不补播", async () => {
    const running = act({ toolCallId: "b", kind: "execute", command: "pnpm test", status: "in_progress", finishedAt: null });
    const wrapper = render([act({ toolCallId: "a", kind: "read", path: "a.ts", startedAt: T, finishedAt: T + 100 }), running]);
    // 挂载即有已完成项：不补播（否则切会话会被历史结算连环喊）
    expect(wrapper.get('[role="status"]').text()).toBe("");

    await wrapper.setProps({
      activities: [
        act({ toolCallId: "a", kind: "read", path: "a.ts", startedAt: T, finishedAt: T + 100 }),
        { ...running, status: "completed", finishedAt: T + 300 },
      ],
    });
    expect(wrapper.get('[role="status"]').text()).toBe("工具调用完成：pnpm test");

    await wrapper.setProps({
      activities: [
        act({ toolCallId: "a", kind: "read", path: "a.ts", startedAt: T, finishedAt: T + 100 }),
        { ...running, status: "completed", finishedAt: T + 300 },
        act({ toolCallId: "c", kind: "execute", command: "pnpm build", status: "failed", finishedAt: T + 900, error: "boom" }),
      ],
    });
    expect(wrapper.get('[role="status"]').text()).toBe("工具调用失败：pnpm build");
  });

  it("结算后显示任务级总耗时（不显示进度数字）", () => {
    const wrapper = render([
      act({ toolCallId: "a", kind: "read", path: "a.ts", startedAt: T, finishedAt: T + 900 }),
      act({ toolCallId: "b", kind: "read", path: "b.ts", startedAt: T + 500, finishedAt: T + 1500 }),
    ]);
    expect(wrapper.find('[data-testid="tool-progress"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="tool-span"]').text()).toBe("1.5s");
  });

  it("全结算后秒表停走：跨度读数冻结（不再每秒重渲染）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T + 1000);
    const wrapper = render([act({ toolCallId: "a", kind: "read", path: "a.ts", startedAt: T, finishedAt: T + 800 })]);
    expect(wrapper.get('[data-testid="tool-span"]').text()).toBe("800ms");
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get('[data-testid="tool-span"]').text()).toBe("800ms");
  });
});

afterEach(() => vi.useRealTimers());
