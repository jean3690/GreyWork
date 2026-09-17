import { describe, expect, it } from "vitest";
import {
  aggregateDiffStat,
  aggregateLifecycle,
  aggregateSummary,
  buildActivityRows,
  diffStatOf,
  durationOf,
  mergeToolActivities,
  parseToolActivityPayload,
  parseToolCallUpdate,
  runningNowLabel,
  settledCount,
  timelineSpan,
  toToolActivity,
  type AggregateRow,
} from "@/lib/tool-activity";
import type { ToolActivity } from "@/types";

const T = 1_700_000_000_000;

function act(partial: Partial<ToolActivity> & { toolCallId: string }): ToolActivity {
  return {
    kind: "read",
    status: "completed",
    startedAt: T,
    finishedAt: T + 100,
    ...partial,
  };
}

describe("toToolActivity", () => {
  it("解析 tool_call 部分（file 类）", () => {
    const a = toToolActivity(
      {
        type: "tool_call",
        id: "tc-1",
        tool_call: { id: "tc-1", name: "Read", kind: "read", input: { file_path: "/a/b.ts" }, status: "completed" },
      },
      T,
      0,
    );
    expect(a).toMatchObject({ toolCallId: "tc-1", kind: "read", status: "completed", path: "/a/b.ts" });
  });

  it("解析 bash execute 命令", () => {
    const a = toToolActivity(
      {
        type: "tool_call",
        id: "tc-2",
        tool_call: { id: "tc-2", name: "Bash", kind: "execute", input: { command: "pnpm test" }, status: "in_progress" },
      },
      T,
      0,
    );
    expect(a).toMatchObject({ kind: "execute", command: "pnpm test", status: "in_progress" });
  });

  it("跳过纯文本部分", () => {
    expect(toToolActivity({ type: "text", text: "hello" }, T, 0)).toBeNull();
  });
});

describe("parseToolActivityPayload", () => {
  it("从 update.content.parts 提取多个工具活动", () => {
    const payload = {
      update: {
        sessionUpdate: "agent_message",
        content: [
          { type: "text", text: "ok" },
          {
            type: "tool_call",
            id: "a",
            tool_call: { id: "a", name: "Write", kind: "edit", input: { file_path: "x.ts" }, status: "completed" },
          },
          { type: "tool_call", id: "b", tool_call: { id: "b", name: "Glob", kind: "search", input: { path: "src" }, status: "completed" } },
        ],
      },
    };
    const out = parseToolActivityPayload(payload, T);
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("edit");
    expect(out[1].kind).toBe("search");
  });

  it("无 update / 纯文本返回空", () => {
    expect(parseToolActivityPayload({ update: { content: [{ type: "text", text: "x" }] } }, T)).toEqual([]);
    expect(parseToolActivityPayload(null, T)).toEqual([]);
  });
});

describe("parseToolCallUpdate（真实 ACP v2 顶层工具调用）", () => {
  it("解析 tool_call_update 首报（kind/status/path）", () => {
    const out = parseToolCallUpdate(
      {
        session_id: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_001",
          title: "Reading configuration file",
          kind: "read",
          status: "pending",
          locations: [{ path: "/home/u/project/src/config.json", line: 42 }],
        },
      },
      T,
    );
    expect(out).toMatchObject({
      toolCallId: "call_001",
      kind: "read",
      status: "pending",
      path: "/home/u/project/src/config.json",
      description: "Reading configuration file",
      finishedAt: null,
    });
  });

  it("execute 从 rawInput 提取命令，terminated 状态映射 interrupted", () => {
    const out = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_002",
          kind: "execute",
          status: "cancelled",
          rawInput: { command: "pnpm test" },
        },
      },
      T,
    );
    expect(out).toMatchObject({ toolCallId: "call_002", kind: "execute", command: "pnpm test", status: "interrupted", finishedAt: T });
  });

  it("diff content 提取变更路径，unknown kind 归 other", () => {
    const out = parseToolCallUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_003",
        kind: "custom_tool",
        status: "completed",
        content: [{ type: "diff", changes: [{ operation: "modify", path: "/home/u/a.ts" }] }],
      },
    })!;
    expect(out.kind).toBe("other");
    expect(out.path).toBe("/home/u/a.ts");
  });

  it("非工具类 sessionUpdate 返回 null；parseToolActivityPayload 路由到该路径", () => {
    expect(parseToolCallUpdate({ update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } } })).toBeNull();
    const acts = parseToolActivityPayload({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_004",
        kind: "search",
        status: "in_progress",
        locations: [{ path: "src" }],
      },
    });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ toolCallId: "call_004", kind: "search", status: "in_progress" });
  });

  it("tool_call_content_chunk 也能解析出同 id 活动（供 merge 续写）", () => {
    const out = parseToolCallUpdate({
      update: { sessionUpdate: "tool_call_content_chunk", toolCallId: "call_005", content: { type: "terminal", terminalId: "t1" } },
    })!;
    expect(out.toolCallId).toBe("call_005");
  });
});

describe("生命周期升级（真实 ACP 事件流）", () => {
  it("pending → in_progress → completed 由 mergeToolActivities 原地升级同一行", () => {
    const c1 = (status: string) =>
      parseToolCallUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "c1", kind: "edit", status } }, T)!;
    let tools = mergeToolActivities([], [c1("pending")]);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("pending");
    tools = mergeToolActivities(tools, [c1("in_progress")]);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("in_progress");
    tools = mergeToolActivities(tools, [c1("completed")]);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("completed");
    expect(tools[0].finishedAt).toBe(T);
  });
});

describe("mergeToolActivities", () => {
  it("按 toolCallId 升级生命周期而非新增", () => {
    const existing: ToolActivity[] = [{ ...act({ toolCallId: "x", status: "in_progress", finishedAt: null }) }];
    const merged = mergeToolActivities(existing, [{ ...act({ toolCallId: "x", status: "completed", finishedAt: T + 500 }) }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("completed");
    expect(merged[0].finishedAt).toBe(T + 500);
  });

  it("新 id 追加", () => {
    const merged = mergeToolActivities([act({ toolCallId: "a" })], [act({ toolCallId: "b" })]);
    expect(merged).toHaveLength(2);
  });
});

describe("buildActivityRows", () => {
  it("同文件同族 completed 折叠为 ×N", () => {
    const rows = buildActivityRows([
      act({ toolCallId: "r1", kind: "read", path: "a.ts" }),
      act({ toolCallId: "r2", kind: "read", path: "a.ts" }),
      act({ toolCallId: "r3", kind: "read", path: "a.ts" }),
    ]);
    expect(rows).toHaveLength(1);
    expect((rows[0] as AggregateRow).repeat).toBe(3);
  });

  it("不同文件不折叠", () => {
    const rows = buildActivityRows([
      act({ toolCallId: "r1", kind: "read", path: "a.ts" }),
      act({ toolCallId: "r2", kind: "read", path: "b.ts" }),
    ]);
    expect(rows).toHaveLength(2);
  });
});

describe("lifecycle / summary", () => {
  it("running 当存在 in_progress", () => {
    expect(
      aggregateLifecycle([
        act({ toolCallId: "x", status: "in_progress", finishedAt: null }),
        act({ toolCallId: "y", status: "completed" }),
      ]),
    ).toBe("running");
  });
  it("done 当全部完成", () => {
    expect(aggregateLifecycle([act({ toolCallId: "x" }), act({ toolCallId: "y" })])).toBe("done");
  });
  it("runningNowLabel 命中当前动作", () => {
    const label = runningNowLabel([act({ toolCallId: "x", status: "in_progress", finishedAt: null, kind: "read", path: "data.csv" })]);
    expect(label).toContain("data.csv");
  });
  it("summary 完成态为过去式计数", () => {
    const s = aggregateSummary(
      [act({ toolCallId: "a", kind: "read", path: "x" }), act({ toolCallId: "b", kind: "read", path: "y" })],
      "done",
    );
    expect(s).toContain("Read 2");
  });
});

describe("durationOf", () => {
  it("已完成返回稳定耗时", () => {
    expect(durationOf(act({ toolCallId: "x", startedAt: 100, finishedAt: 1600 }))).toBe(1500);
  });
});

describe("timelineSpan / settledCount", () => {
  it("timelineSpan 取最早开始到最晚结束（并行调用算一次墙钟）", () => {
    const span = timelineSpan([
      act({ toolCallId: "a", startedAt: T, finishedAt: T + 900 }),
      act({ toolCallId: "b", startedAt: T + 500, finishedAt: T + 1500 }),
    ]);
    expect(span).toBe(1500);
  });

  it("飞行中的调用按 now 计时", () => {
    const span = timelineSpan([act({ toolCallId: "a", startedAt: T, status: "in_progress", finishedAt: null })], T + 1200);
    expect(span).toBe(1200);
  });

  it("空时间线返回 null（不显示耗时）", () => {
    expect(timelineSpan([])).toBeNull();
  });

  it("settledCount 只计已结算调用", () => {
    expect(
      settledCount([
        act({ toolCallId: "a", status: "completed" }),
        act({ toolCallId: "b", status: "in_progress", finishedAt: null }),
        act({ toolCallId: "c", status: "pending", finishedAt: null }),
        act({ toolCallId: "d", status: "failed" }),
      ]),
    ).toBe(2);
  });
});

// MCP 调用的身份只藏在 title 里（agent 把 `mcp__<server>__<tool>` 原样塞进去、kind 一律 other），
// 不在解析层拆出来，UI 就只能显示一坨 `mcp__deepwiki__ask_question` 或干脆什么都不显示。
describe("MCP 工具识别", () => {
  it("从 tool_call 的 title 拆出服务器与工具名", () => {
    const a = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "toolu_01",
          title: "mcp__deepwiki__ask_question",
          kind: "other",
          status: "in_progress",
          rawInput: { repoName: "iOfficeAI/AionUi", question: "team mode?" },
        },
      },
      T,
    );
    expect(a).toMatchObject({
      toolCallId: "toolu_01",
      mcpServer: "deepwiki",
      name: "ask_question",
      description: "ask_question",
      status: "in_progress",
    });
  });

  it("客户端内建桥 mcp__acp__* 不算外部 MCP，但工具名照样剥出来", () => {
    const a = parseToolCallUpdate(
      { update: { sessionUpdate: "tool_call", toolCallId: "t2", title: "mcp__acp__Read", kind: "read", status: "completed" } },
      T,
    );
    expect(a?.mcpServer).toBeUndefined();
    expect(a).toMatchObject({ name: "Read", description: "Read" });
  });

  it("普通工具的人话 title 原样保留", () => {
    const a = parseToolCallUpdate(
      { update: { sessionUpdate: "tool_call", toolCallId: "t3", title: "Read src/main.ts", kind: "read", status: "completed" } },
      T,
    );
    expect(a?.mcpServer).toBeUndefined();
    expect(a?.description).toBe("Read src/main.ts");
  });

  it("Anthropic 风格内嵌 tool_call.name 也识别", () => {
    const a = toToolActivity(
      { type: "tool_call", id: "t4", tool_call: { id: "t4", name: "mcp__deepwiki__read_wiki_structure", input: {}, status: "completed" } },
      T,
      0,
    );
    expect(a).toMatchObject({ mcpServer: "deepwiki", name: "read_wiki_structure", description: "read_wiki_structure" });
  });

  it("后续 tool_call_update 不带 title 时不丢服务器归属", () => {
    const first = parseToolCallUpdate(
      { update: { sessionUpdate: "tool_call", toolCallId: "t5", title: "mcp__deepwiki__ask_question", status: "pending" } },
      T,
    );
    const done = parseToolCallUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "t5", status: "completed" } }, T + 900);
    const merged = mergeToolActivities([first as ToolActivity], [done as ToolActivity]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ mcpServer: "deepwiki", name: "ask_question", status: "completed" });
  });

  it("运行中摘要点名是哪台服务器在干活", () => {
    const label = runningNowLabel([
      act({ toolCallId: "t6", kind: "other", status: "in_progress", finishedAt: null, mcpServer: "deepwiki", name: "ask_question" }),
    ]);
    expect(label).toBe("Calling deepwiki · ask_question");
  });
});

// 时间线只报「调了 write」没用，得能看见写了什么：ACP 把内容放在 content 内容块 /
// rawInput / rawOutput 三处，解析层要归一成一份可展开的细节。
describe("工具调用细节", () => {
  it("write：diff 内容块进 detail.diff，已展示过的入参不重复进 args", () => {
    const a = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "w1",
          title: "Write src/a.ts",
          kind: "edit",
          status: "in_progress",
          locations: [{ path: "/w/src/a.ts" }],
          rawInput: { file_path: "/w/src/a.ts", content: "line1\nline2\n" },
          content: [{ type: "diff", path: "/w/src/a.ts", oldText: null, newText: "line1\nline2\n" }],
        },
      },
      T,
    );
    expect(a?.detail?.diff).toEqual({ path: "/w/src/a.ts", oldText: null, newText: "line1\nline2\n" });
    expect(a?.detail?.args).toBeUndefined();
  });

  it("edit：oldText/newText 都留下，供逐行 ± 展示", () => {
    const a = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "e1",
          status: "completed",
          content: [{ type: "diff", path: "a.ts", oldText: "old", newText: "new" }],
        },
      },
      T,
    );
    expect(a?.detail?.diff).toMatchObject({ oldText: "old", newText: "new" });
  });

  it("读取 / 命令输出：文本内容块合并进 detail.text", () => {
    const a = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "r1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "第一行" } },
            { type: "content", content: { type: "text", text: "第二行" } },
          ],
        },
      },
      T,
    );
    expect(a?.detail?.text).toBe("第一行\n第二行");
  });

  it("MCP：入参进 args，结果从 rawOutput 的 content 块取文本", () => {
    const a = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "m1",
          title: "mcp__deepwiki__ask_question",
          kind: "other",
          status: "completed",
          rawInput: { repoName: "iOfficeAI/AionUi", question: "team mode?" },
          rawOutput: { content: [{ type: "text", text: "答案正文" }] },
        },
      },
      T,
    );
    expect(a?.detail?.text).toBe("答案正文");
    expect(JSON.parse(a?.detail?.args ?? "{}")).toEqual({ repoName: "iOfficeAI/AionUi", question: "team mode?" });
  });

  it("终端内容块只登记 terminalId（输出走终端通道）", () => {
    const a = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "b1",
          kind: "execute",
          status: "in_progress",
          content: [{ type: "terminal", terminalId: "term-9" }],
        },
      },
      T,
    );
    expect(a?.detail).toEqual({ terminalId: "term-9" });
  });

  it("超长内容截断留存并打标（会话要落盘，不能塞整个大文件）", () => {
    const huge = "x".repeat(9000);
    const a = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "h1",
          status: "completed",
          content: [{ type: "diff", path: "big.txt", oldText: null, newText: huge }],
        },
      },
      T,
    );
    expect(a?.detail?.diff?.newText).toHaveLength(8000);
    expect(a?.detail?.clipped).toBe(true);
  });

  it("后续 update 不带 content 时不清空已收到的细节", () => {
    const first = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "k1",
          status: "in_progress",
          content: [{ type: "diff", path: "a.ts", oldText: null, newText: "写入" }],
        },
      },
      T,
    );
    const done = parseToolCallUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "k1", status: "completed" } }, T + 500);
    const merged = mergeToolActivities([first as ToolActivity], [done as ToolActivity]);
    expect(merged[0]?.detail?.diff?.newText).toBe("写入");
    expect(merged[0]?.status).toBe("completed");
  });
});

describe("diffStatOf / aggregateDiffStat", () => {
  it("改动类调用按旧/新文本算出行级增删；read 不算", () => {
    expect(
      diffStatOf(
        act({
          toolCallId: "e1",
          kind: "edit",
          path: "a.ts",
          detail: { diff: { path: "a.ts", oldText: "old\ntail", newText: "new\ntail\nmore" } },
        }),
      ),
    ).toEqual({ added: 2, removed: 1 });
    expect(
      diffStatOf(act({ toolCallId: "r1", kind: "read", path: "a.ts", detail: { diff: { path: "a.ts", oldText: null, newText: "x" } } })),
    ).toBeNull();
    expect(diffStatOf(act({ toolCallId: "n1", kind: "edit", path: "a.ts" }))).toBeNull();
  });

  it("整文件写入（oldText 为 null）只计新增", () => {
    expect(
      diffStatOf(act({ toolCallId: "w1", kind: "edit", detail: { diff: { path: "a.ts", oldText: null, newText: "a\nb\nc" } } })),
    ).toEqual({ added: 3, removed: 0 });
  });

  it("汇总多条调用的改动量；一条 diff 都没有时为 null", () => {
    const edited = act({
      toolCallId: "e1",
      kind: "edit",
      detail: { diff: { path: "a.ts", oldText: "a", newText: "b\nc" } },
    });
    const removed = act({ toolCallId: "d1", kind: "delete", detail: { diff: { path: "b.ts", oldText: "x\ny", newText: "" } } });
    expect(aggregateDiffStat([edited, removed])).toEqual({ added: 2, removed: 3 });
    expect(aggregateDiffStat([act({ toolCallId: "r1", kind: "read", path: "a.ts" })])).toBeNull();
  });
});

describe("AskUserQuestion 识别", () => {
  it("名为 AskUserQuestion 的调用挂上归一化后的 questions", () => {
    const a = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "ask1",
          title: "AskUserQuestion",
          status: "in_progress",
          rawInput: { questions: [{ question: "继续吗", options: [{ label: "继续" }, { label: "停" }] }] },
        },
      },
      T,
    );
    expect(a?.ask?.questions).toHaveLength(1);
    expect(a?.ask?.questions[0]?.question).toBe("继续吗");
    expect(a?.ask?.questions[0]?.options.map((option) => option.label)).toEqual(["继续", "停"]);
  });

  it("普通工具不带 ask 载荷", () => {
    const a = parseToolCallUpdate({ update: { sessionUpdate: "tool_call", toolCallId: "r1", title: "Read", status: "completed" } }, T);
    expect(a?.ask).toBeUndefined();
  });

  it("ask 载荷在生命周期续写时保留", () => {
    const first = parseToolCallUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "ask2",
          title: "AskUserQuestion",
          status: "in_progress",
          rawInput: { questions: [{ question: "q", options: [{ label: "a" }] }] },
        },
      },
      T,
    );
    const done = parseToolCallUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "ask2", status: "completed" } }, T + 500);
    const merged = mergeToolActivities([first as ToolActivity], [done as ToolActivity]);
    expect(merged[0]?.ask?.questions).toHaveLength(1);
  });
});
