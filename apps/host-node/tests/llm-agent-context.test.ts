/**
 * 上下文预算：超了就折叠较早的工具结果，但不删消息（tool_call / tool 必须成对）。
 */
import { describe, expect, it } from "vitest";

import { compactHistory, estimateContextTokens } from "../src/llm-agent.js";

function toolMessage(id: string, text: string): Record<string, unknown> {
  return { role: "tool", tool_call_id: id, content: text };
}

describe("上下文预算", () => {
  it("token 估算区分 ASCII 与中文", () => {
    expect(estimateContextTokens("a".repeat(400))).toBe(100);
    expect(estimateContextTokens("中".repeat(100))).toBe(100);
  });

  it("未超预算时一条都不折", () => {
    const history = [{ role: "system", content: "system" }, toolMessage("c1", "短结果"), { role: "user", content: "继续" }];
    expect(compactHistory(history, 32_000)).toBe(0);
    expect(history.map((m) => m.content)).toEqual(["system", "短结果", "继续"]);
  });

  it("超预算折叠较早的工具结果，最近 6 条与配对关系不变", () => {
    const big = "x".repeat(20_000);
    const history: Record<string, unknown>[] = [
      { role: "system", content: "system" },
      ...Array.from({ length: 8 }, (_, index) => toolMessage("c" + index, big)),
      { role: "user", content: "最后一条" },
    ];
    const before = history.length;
    const folded = compactHistory(history, 4_000);
    expect(folded).toBeGreaterThan(0);
    expect(history).toHaveLength(before);
    // 折叠的是靠前的：前几条带标记，最新那条原样。
    expect(String(history[1].content).startsWith("[较早的工具结果已折叠]")).toBe(true);
    expect(history[history.length - 2].content).toBe(big);
    // system / user 一律不动
    expect(history[0].content).toBe("system");
    expect(history[history.length - 1].content).toBe("最后一条");
    // 每条 tool 消息的 tool_call_id 仍在（配对没断）
    for (const message of history) {
      if (message.role === "tool") expect(typeof message.tool_call_id).toBe("string");
    }
  });

  it("重复调用不会把占位符再折一次", () => {
    const big = "y".repeat(20_000);
    const history: Record<string, unknown>[] = [
      { role: "system", content: "s" },
      ...Array.from({ length: 8 }, (_, index) => toolMessage("c" + index, big)),
    ];
    compactHistory(history, 4_000);
    const snapshot = history.map((message) => message.content);
    compactHistory(history, 4_000);
    expect(history.map((message) => message.content)).toEqual(snapshot);
  });

  it("assistant 的 tool_calls 不被裁（只动 tool 消息内容）", () => {
    const history: Record<string, unknown>[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      toolMessage("c1", "z".repeat(20_000)),
      { role: "user", content: "继续" },
    ];
    compactHistory(history, 4_000);
    expect(Array.isArray(history[0].tool_calls)).toBe(true);
  });
});
