// 回合改动摘要：同一文件多次写入按「首旧文 → 末新文」算净增删，避免中间态重复计数；
// 流式中不渲染；点文件发 preview:request（跨面板，不直连 store）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "@/i18n";
import { appEvents } from "@/events";
import TurnDiffSummary from "@/features/conversation/TurnDiffSummary.vue";
import type { ToolActivity } from "@/types";

function edit(toolCallId: string, path: string, oldText: string, newText: string): ToolActivity {
  return {
    toolCallId,
    kind: "edit",
    status: "completed",
    startedAt: 0,
    finishedAt: 1,
    path,
    detail: { diff: { path, oldText, newText } },
  };
}

const activities: ToolActivity[] = [
  edit("1", "src/a.ts", "const a = 1;\n", "const a = 2;\n"),
  edit("2", "src/a.ts", "const a = 2;\n", "const a = 3;\nconst b = 1;\n"),
  { toolCallId: "3", kind: "read", status: "completed", startedAt: 0, finishedAt: 1, path: "src/b.ts" },
];

function mountSummary(props: Record<string, unknown> = {}) {
  return mount(TurnDiffSummary, { props: { activities, ...props }, global: { plugins: [i18n] } });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TurnDiffSummary", () => {
  it("按路径去重，净增删用首旧文 → 末新文；只统计会改文件的调用", () => {
    const wrapper = mountSummary();

    expect(wrapper.get('[data-testid="turn-diff-summary"]').text()).toContain("改动了 1 个文件");
    // 1 → 3 加一行 b = 1：+2 −1
    expect(wrapper.get('[data-testid="turn-diff-total"]').text()).toContain("+2");
    expect(wrapper.get('[data-testid="turn-diff-total"]').text()).toContain("-1");
  });

  it("默认收起，展开后列出文件并可点开预览", async () => {
    const requests: unknown[] = [];
    const off = appEvents.on("preview:request", (payload) => requests.push(payload));

    const wrapper = mountSummary();
    expect(wrapper.findAll('[data-testid="turn-diff-file"]')).toHaveLength(0);

    await wrapper.get('[data-testid="turn-diff-summary"] button').trigger("click");
    const rows = wrapper.findAll('[data-testid="turn-diff-file"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain("a.ts");
    expect(rows[0].text()).toContain("src");

    await rows[0].trigger("click");
    expect(requests).toEqual([{ path: "src/a.ts", name: "a.ts", source: "disk" }]);
    off();
  });

  it("流式中不渲染；没有文件改动也不渲染", () => {
    expect(mountSummary({ streaming: true }).find('[data-testid="turn-diff-summary"]').exists()).toBe(false);

    const noChanges = mount(TurnDiffSummary, {
      props: { activities: [{ toolCallId: "1", kind: "execute", status: "completed", startedAt: 0, finishedAt: 1 }] },
      global: { plugins: [i18n] },
    });
    expect(noChanges.find('[data-testid="turn-diff-summary"]').exists()).toBe(false);
  });
});
