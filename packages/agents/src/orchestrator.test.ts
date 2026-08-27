import { describe, expect, it } from "vitest";
import {
  agentStatusLabel,
  createAgentLoopState,
  loopExhausted,
  nextRound,
  planProgressText,
  stepToResult,
  type AgentStepRecord,
} from "./orchestrator";
import type { Agent } from "./types";

const dummyAgent: Agent = {
  id: "agent-x",
  name: "X",
  role: "planner",
  status: "working",
  progress: 0,
  tags: [],
};

function record(round: number): AgentStepRecord {
  return { round, agentId: "agent-x", action: `act-${round}` };
}

describe("createAgentLoopState", () => {
  it("初始 round 为 0 且 history 为空", () => {
    const state = createAgentLoopState(dummyAgent, { maxRounds: 5 });
    expect(state.round).toBe(0);
    expect(state.history).toEqual([]);
  });

  it("保留传入的 config（含可选字段）", () => {
    const config = { maxRounds: 3, modelProvider: "mock", toolAllowlist: ["gis"] };
    const state = createAgentLoopState(dummyAgent, config);
    expect(state.config).toBe(config);
  });
});

describe("nextRound", () => {
  it("round 递增并把记录追加到 history 末尾", () => {
    let state = createAgentLoopState(dummyAgent, { maxRounds: 10 });
    state = nextRound(state, record(0));
    state = nextRound(state, record(1));
    expect(state.round).toBe(2);
    expect(state.history.map((r) => r.action)).toEqual(["act-0", "act-1"]);
  });

  it("不可变：原 state 与 history 不被修改", () => {
    const before = createAgentLoopState(dummyAgent, { maxRounds: 10 });
    const snapshot = [...before.history];
    nextRound(before, record(0));
    expect(before.round).toBe(0);
    expect(before.history).toEqual(snapshot);
  });
});

describe("loopExhausted", () => {
  it("round < maxRounds 时未耗尽", () => {
    const state = createAgentLoopState(dummyAgent, { maxRounds: 3 });
    expect(loopExhausted(nextRound(nextRound(state, record(0)), record(1)))).toBe(false);
  });

  it("round === maxRounds 时判定耗尽（边界）", () => {
    let state = createAgentLoopState(dummyAgent, { maxRounds: 3 });
    for (let i = 0; i < 3; i++) state = nextRound(state, record(i));
    expect(loopExhausted(state)).toBe(true);
  });

  it("maxRounds=0 时立即耗尽", () => {
    const state = createAgentLoopState(dummyAgent, { maxRounds: 0 });
    expect(loopExhausted(state)).toBe(true);
  });

  it("超过 maxRounds 后持续为真", () => {
    let state = createAgentLoopState(dummyAgent, { maxRounds: 1 });
    state = nextRound(state, record(0));
    state = nextRound(state, record(1));
    expect(loopExhausted(state)).toBe(true);
  });
});

describe("stepToResult", () => {
  const step = { id: "step-1", kind: "analyze" as const, label: "", agentRole: "planner" as const };

  it("成功结果不带 error", () => {
    const result = stepToResult(step, true, "out");
    expect(result).toMatchObject({ stepId: "step-1", ok: true, output: "out" });
    expect(result.error).toBeUndefined();
  });

  it("失败结果 error 为固定文案且不携带 output 语义混淆", () => {
    const result = stepToResult(step, false, "partial");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("step failed");
    expect(result.stepId).toBe("step-1");
  });
});

describe("planProgressText", () => {
  it("按 名称 · 进度% · 状态 拼接", () => {
    const plan = defaultPlanStub();
    expect(planProgressText(plan)).toBe("城市态势空间报告 · 50% · running");
  });
});

describe("agentStatusLabel", () => {
  it("四种状态均有中文映射且无 undefined", () => {
    expect(agentStatusLabel("idle")).toBe("待命");
    expect(agentStatusLabel("working")).toBe("工作中");
    expect(agentStatusLabel("blocked")).toBe("阻塞");
    expect(agentStatusLabel("offline")).toBe("离线");
  });
});

function defaultPlanStub() {
  return {
    id: "p",
    name: "城市态势空间报告",
    steps: [],
    status: "running" as const,
    progress: 50,
  };
}
