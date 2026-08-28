import type { Agent } from "./types";

export const MOCK_AGENTS: Agent[] = [
  { id: "agent-alpha", name: "Alpha · 总规划", role: "planner", status: "working", progress: 64, tags: ["mission", "orchestrate"] },
  { id: "agent-gist", name: "Gist · 地理情报", role: "geo-analyst", status: "working", progress: 81, tags: ["gis", "layers"] },
  { id: "agent-forge", name: "Forge · 空间成型", role: "spatial-artist", status: "working", progress: 47, tags: ["3d", "mesh"] },
  { id: "agent-check", name: "Check · 质量审查", role: "reviewer", status: "idle", progress: 0, tags: ["qa", "review"] },
];
