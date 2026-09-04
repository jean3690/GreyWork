import { describe, expect, it } from "vitest";
import { MOCK_AGENTS } from "../../src/factory";
import { AGENT_ROLES, type AgentStatus } from "../../src/types";

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
