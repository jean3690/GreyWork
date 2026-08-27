export type AgentRole = "planner" | "researcher" | "builder" | "geo-analyst" | "spatial-artist" | "reviewer";

export type AgentStatus = "idle" | "working" | "blocked" | "offline";

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  progress: number;
  tags: string[];
}

export interface AgentEvent {
  agentId: string;
  at: string;
  message: string;
}

export interface AgentLoopConfig {
  maxRounds: number;
  modelProvider?: string;
  toolAllowlist?: string[];
  skillIds?: string[];
}

export const AGENT_ROLES: AgentRole[] = ["planner", "researcher", "builder", "geo-analyst", "spatial-artist", "reviewer"];

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  planner: "规划者",
  researcher: "研究员",
  builder: "执行者",
  "geo-analyst": "地理分析师",
  "spatial-artist": "空间建模师",
  reviewer: "审查员",
};
