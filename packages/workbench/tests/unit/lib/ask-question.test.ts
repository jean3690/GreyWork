/**
 * AskUserQuestion 载荷归一化与作答格式化。
 * 校验从严是关键：畸形入参必须返回 null（整块不渲染），否则会给出点了推不动回合的空壳卡片。
 */
import { describe, expect, it } from "vitest";
import { formatAnswerLine, formatAskAnswer, isAskSettled, isAskToolName, normalizeAskRequest } from "@/lib/ask-question";

describe("isAskToolName", () => {
  it("识别各种写法（大小写 / 下划线 / 连字符）", () => {
    expect(isAskToolName("AskUserQuestion")).toBe(true);
    expect(isAskToolName("ask_user_question")).toBe(true);
    expect(isAskToolName("ask_user")).toBe(true);
    expect(isAskToolName("ASK-USER-QUESTION")).toBe(true);
    expect(isAskToolName("Read")).toBe(false);
    expect(isAskToolName(undefined)).toBe(false);
    expect(isAskToolName("mcp__deepwiki__ask_question")).toBe(false);
  });
});

describe("normalizeAskRequest", () => {
  it("完整入参对象：题干 / 选项 / header / 多选都保留", () => {
    const result = normalizeAskRequest({
      questions: [
        {
          header: "范围",
          question: "选哪些模块？",
          multiSelect: true,
          options: [{ label: "前端", description: "UI 层" }, { label: "后端" }],
        },
      ],
    });
    expect(result).toEqual({
      questions: [
        {
          header: "范围",
          question: "选哪些模块？",
          multiSelect: true,
          options: [
            { label: "前端", description: "UI 层" },
            { label: "后端", description: undefined },
          ],
        },
      ],
    });
  });

  it("也接受直接传题目数组", () => {
    const result = normalizeAskRequest([{ question: "继续吗", options: [{ label: "是" }] }]);
    expect(result?.questions).toHaveLength(1);
    expect(result?.questions[0]?.question).toBe("继续吗");
    expect(result?.questions[0]?.multiSelect).toBe(false);
  });

  it("题干为空 / 无可用选项 / 非对象：返回 null（不渲染空壳）", () => {
    expect(normalizeAskRequest({ questions: [{ question: "  ", options: [{ label: "a" }] }] })).toBeNull();
    expect(normalizeAskRequest({ questions: [{ question: "q", options: [] }] })).toBeNull();
    expect(normalizeAskRequest({ questions: [{ question: "q", options: [{ label: "" }, { nope: 1 }] }] })).toBeNull();
    expect(normalizeAskRequest("nope")).toBeNull();
    expect(normalizeAskRequest(null)).toBeNull();
    expect(normalizeAskRequest({})).toBeNull();
  });

  it("丢弃畸形选项但保留合法项；保留畸形题目外的合法题目", () => {
    const result = normalizeAskRequest({
      questions: [{ question: "q", options: [{ label: "ok" }, { bad: true }, { label: "  " }] }],
    });
    expect(result?.questions[0]?.options).toEqual([{ label: "ok", description: undefined }]);
  });

  it("选项数量封顶 8 个", () => {
    const options = Array.from({ length: 12 }, (_, index) => ({ label: `o${index}` }));
    const result = normalizeAskRequest({ questions: [{ question: "q", options }] });
    expect(result?.questions[0]?.options).toHaveLength(8);
  });
});

describe("isAskSettled", () => {
  it("有 answeredAt 即视为已收口", () => {
    expect(isAskSettled({ questions: [], answeredAt: 123 })).toBe(true);
    expect(isAskSettled({ questions: [] })).toBe(false);
    expect(isAskSettled(undefined)).toBe(false);
  });
});

describe("formatAnswerLine / formatAskAnswer", () => {
  it("单选题：问题与所选项", () => {
    expect(formatAnswerLine({ question: "去哪", labels: ["北京"] })).toBe("去哪：北京");
  });

  it("多选题：前缀标注，避免 agent 当单选理解；自由输入并入", () => {
    const request = {
      questions: [{ question: "选模块", options: [{ label: "a" }], multiSelect: true }],
      answers: [{ question: "选模块", labels: ["a", "b"], custom: "还有 c" }],
    };
    expect(formatAskAnswer(request)).toBe("[多选] 选模块：a、b、还有 c");
  });

  it("未作答的题显式标注，不假装有答案", () => {
    expect(formatAnswerLine({ question: "q", labels: [] })).toBe("q：（未作答）");
  });
});
