import { describe, expect, it } from "vitest";
import { advanceAgent, createAgent, emitAgentEvent, MOCK_AGENTS, setAgentStatus } from "./factory";
import { AGENT_ROLES, type AgentStatus } from "./types";

describe("createAgent", () => {
  it("默认 role/name 为 planner，初始状态 idle、progress 0、tags 空", () => {
    const agent = createAgent("a-1");
    expect(agent.role).toBe("planner");
    expect(agent.name).toBe("planner");
    expect(agent.status).toBe("idle");
    expect(agent.progress).toBe(0);
    expect(agent.tags).toEqual([]);
  });

  it("显式传入 role 时 name 默认取 role 值", () => {
    const agent = createAgent("a-2", "geo-analyst");
    expect(agent.role).toBe("geo-analyst");
    expect(agent.name).toBe("geo-analyst");
  });

  it("显式 name 覆盖默认", () => {
    expect(createAgent("a-3", "reviewer", "质检员").name).toBe("质检员");
  });
});

describe("setAgentStatus", () => {
  it("更新 status 且不修改原对象", () => {
    const base = createAgent("a-1");
    const next = setAgentStatus(base, "working");
    expect(next.status).toBe("working");
    expect(base.status).toBe("idle");
  });

  it("其余字段保持不变", () => {
    const base = createAgent("a-1", "builder", "B");
    const next = setAgentStatus(base, "blocked");
    expect(next).toEqual({ ...base, status: "blocked" });
  });
});

describe("advanceAgent", () => {
  it("working 状态下按 delta 推进 progress（默认 +1）", () => {
    const working = setAgentStatus(createAgent("a"), "working");
    expect(advanceAgent(working).progress).toBe(1);
    expect(advanceAgent(working, 10).progress).toBe(10);
  });

  it("非 working 状态推进无效：返回原对象且 progress 不变", () => {
    for (const status of ["idle", "blocked", "offline"] as AgentStatus[]) {
      const agent = setAgentStatus(createAgent("a"), status);
      const advanced = advanceAgent(agent, 5);
      expect(advanced.progress).toBe(0);
      expect(advanced).toBe(agent); // 实现对非 working 直接短路返回
    }
  });

  it("progress 上限钳制到 100", () => {
    let agent = setAgentStatus(createAgent("a"), "working");
    agent = advanceAgent(agent, 99);
    expect(agent.progress).toBe(99);
    agent = advanceAgent(agent, 50);
    expect(agent.progress).toBe(100);
    agent = advanceAgent(agent, 50);
    expect(agent.progress).toBe(100); // 不越过上限
  });

  it("负 delta 下限钳制到 0", () => {
    const working = setAgentStatus(createAgent("a"), "working");
    expect(advanceAgent(working, -7).progress).toBe(0);
  });
});

describe("emitAgentEvent", () => {
  it("携带 agentId 与 message，at 为 ISO8601 时间戳", () => {
    const before = Date.now();
    const event = emitAgentEvent("agent-alpha", "开始采集");
    const after = Date.now();
    expect(event.agentId).toBe("agent-alpha");
    expect(event.message).toBe("开始采集");
    const at = new Date(event.at).getTime();
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(after + 1000);
  });
});

describe("MOCK_AGENTS 结构不变性", () => {
  it("id 全局唯一且非空", () => {
    const ids = MOCK_AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });

  it("role 必须属于 AGENT_ROLES 合法集合", () => {
    for (const agent of MOCK_AGENTS) {
      expect(AGENT_ROLES).toContain(agent.role);
    }
  });

  it("status 属于合法状态集，progress 在 [0,100] 内", () => {
    const valid: AgentStatus[] = ["idle", "working", "blocked", "offline"];
    for (const agent of MOCK_AGENTS) {
      expect(valid).toContain(agent.status);
      expect(agent.progress).toBeGreaterThanOrEqual(0);
      expect(agent.progress).toBeLessThanOrEqual(100);
    }
  });

  it("name 非空且 tags 为字符串数组", () => {
    for (const agent of MOCK_AGENTS) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(Array.isArray(agent.tags)).toBe(true);
    }
  });
});
