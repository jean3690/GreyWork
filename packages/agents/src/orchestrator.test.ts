import { describe, expect, it } from "vitest";
import { buildPlanPrompt, createPlannerRun, parsePlan } from "./orchestrator";

describe("createPlannerRun", () => {
  it("初始状态为 planning，无子任务，id 递增且非空", () => {
    const a = createPlannerRun("梳理项目改动");
    const b = createPlannerRun("生成日报");
    expect(a.id).not.toBe(b.id);
    expect(a.goal).toBe("梳理项目改动");
    expect(a.status).toBe("planning");
    expect(a.subtasks).toEqual([]);
    expect(a.finishedAt).toBeUndefined();
  });
});

describe("buildPlanPrompt", () => {
  it("包含目标与 JSON 格式约束，要求自包含子任务", () => {
    const prompt = buildPlanPrompt("分析客流数据");
    expect(prompt).toContain("分析客流数据");
    expect(prompt).toContain("[{");
    expect(prompt).toContain("role");
    expect(prompt).toContain("prompt");
  });
});

describe("parsePlan", () => {
  it("解析纯 JSON 数组，校验 role 合法性并跳过空 prompt", () => {
    const text = JSON.stringify([
      { role: "researcher", prompt: "抓取客流数据" },
      { role: "geo-analyst", prompt: "空间聚类" },
      { role: "unknown-role", prompt: "非法角色" },
      { role: "builder", prompt: "" },
    ]);
    const plan = parsePlan(text);
    expect(plan).not.toBeNull();
    expect(plan).toHaveLength(3);
    expect(plan?.[0]).toMatchObject({ role: "researcher", prompt: "抓取客流数据", status: "pending" });
    expect(plan?.[1]).toMatchObject({ role: "geo-analyst", prompt: "空间聚类" });
    expect(plan?.[1]?.id).toBe("sub-2");
    // 非法角色回退 builder；空 prompt 被跳过
    expect(plan?.[2]).toMatchObject({ role: "builder", prompt: "非法角色" });
  });

  it("从夹杂解释文字的文本中提取 JSON", () => {
    const text = '好的，以下是计划：\n```json\n[{"role":"builder","prompt":"重构三栏布局"}]\n```\n请审阅。';
    const plan = parsePlan(text);
    expect(plan).toHaveLength(1);
    expect(plan?.[0]?.role).toBe("builder");
  });

  it("无 JSON / 非数组 / 语法错误时返回 null", () => {
    expect(parsePlan("没有计划")).toBeNull();
    expect(parsePlan('{"role":"builder"}')).toBeNull();
    expect(parsePlan("[{bad json")).toBeNull();
    expect(parsePlan("[]")).toBeNull();
    expect(parsePlan("")).toBeNull();
  });
});
