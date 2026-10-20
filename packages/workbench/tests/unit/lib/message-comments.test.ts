// 选区评论的提示词拼装契约：引用拼到正文前、多行逐行加前缀、空正文只留引用。
import { describe, expect, it } from "vitest";
import { buildCommentPrompt, quoteSummary } from "@/lib/message-comments";
import type { MessageComment } from "@/types";

const comment = (over: Partial<MessageComment> = {}): MessageComment => ({
  id: "c1",
  quote: "原句",
  note: "批注",
  createdAt: 1,
  ...over,
});

describe("buildCommentPrompt", () => {
  it("无评论时原样返回正文", () => {
    expect(buildCommentPrompt("hello", [])).toBe("hello");
  });

  it("把引用拼到正文前（批注文本已在正文里，不重复拼）", () => {
    expect(buildCommentPrompt("这里要改", [comment({ quote: "原句" })])).toBe("> 原句\n\n这里要改");
  });

  it("多行引用逐行加 > 前缀", () => {
    expect(buildCommentPrompt("x", [comment({ quote: "a\nb" })])).toBe("> a\n> b\n\nx");
  });

  it("正文为空时只输出引用", () => {
    expect(buildCommentPrompt("   ", [comment({ quote: "原句" })])).toBe("> 原句");
  });

  it("多条评论以空行分隔", () => {
    const out = buildCommentPrompt("t", [comment({ quote: "a" }), comment({ id: "c2", quote: "b" })]);
    expect(out).toBe("> a\n\n> b\n\nt");
  });
});

describe("quoteSummary", () => {
  it("折叠空白", () => {
    expect(quoteSummary("  a   b  ")).toBe("a b");
  });

  it("超长截断并加省略号", () => {
    const out = quoteSummary("x".repeat(100));
    expect(out).toHaveLength(81);
    expect(out.endsWith("…")).toBe(true);
  });
});
