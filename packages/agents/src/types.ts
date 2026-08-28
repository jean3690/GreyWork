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

export interface AgentLoopConfig {
  maxRounds: number;
  modelProvider?: string;
  toolAllowlist?: string[];
  skillIds?: string[];
}

export const AGENT_ROLES: AgentRole[] = ["planner", "researcher", "builder", "geo-analyst", "spatial-artist", "reviewer"];
