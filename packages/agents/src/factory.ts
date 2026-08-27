import { clamp } from "@greywork/core";
import type { Agent, AgentEvent, AgentRole, AgentStatus } from "./types";

export function createAgent(id: string, role: AgentRole = "planner", name: string = role): Agent {
  return {
    id,
    name,
    role,
    status: "idle",
    progress: 0,
    tags: [],
  };
}

export function setAgentStatus(agent: Agent, status: AgentStatus): Agent {
  return { ...agent, status };
}

export function advanceAgent(agent: Agent, delta = 1): Agent {
  if (agent.status !== "working") return agent;
  return {
    ...agent,
    progress: clamp(agent.progress + delta, 0, 100),
  };
}

export function emitAgentEvent(agentId: string, message: string): AgentEvent {
  return {
    agentId,
    at: new Date().toISOString(),
    message,
  };
}

export const MOCK_AGENTS: Agent[] = [
  { id: "agent-alpha", name: "Alpha · 总规划", role: "planner", status: "working", progress: 64, tags: ["mission", "orchestrate"] },
  { id: "agent-gist", name: "Gist · 地理情报", role: "geo-analyst", status: "working", progress: 81, tags: ["gis", "layers"] },
  { id: "agent-forge", name: "Forge · 空间成型", role: "spatial-artist", status: "working", progress: 47, tags: ["3d", "mesh"] },
  { id: "agent-check", name: "Check · 质量审查", role: "reviewer", status: "idle", progress: 0, tags: ["qa", "review"] },
];
