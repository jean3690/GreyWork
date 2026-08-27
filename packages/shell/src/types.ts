import type { AgentLoopConfig } from "@greywork/agents";
import type { CommandPolicy } from "@greywork/plugins";

export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "max";

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activeView: "overview" | "agents" | "spatial" | "gis" | "editor" | "analytics" | "market" | "settings";
  pluginIds: string[];
  agentLoop?: AgentLoopConfig;
}

export interface ModelProviderConfig {
  id: string;
  name: string;
  kind: "openai-compatible" | "anthropic" | "ollama" | "custom";
  baseUrl?: string;
  model: string;
  apiKeyEnv?: string;
  enabled: boolean;
  reasoningEffort?: ReasoningEffort;
}

export interface WebSearchProviderConfig {
  id: string;
  name: string;
  endpoint?: string;
  apiKeyEnv?: string;
  enabled: boolean;
}

export interface PluginMarketEntry {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  tags: string[];
  downloads: number;
  rating: number;
}

export interface AiLoopPolicy {
  maxRounds: number;
  commandGuard: CommandPolicy;
  toolAllowlist?: string[];
  requireApproval?: string[];
}

export interface ShellState {
  sessions: SessionMeta[];
  modelProviders: ModelProviderConfig[];
  webSearchProviders: WebSearchProviderConfig[];
  pluginMarket: PluginMarketEntry[];
  aiLoopPolicy: AiLoopPolicy;
}

export interface SessionManager {
  createSession(title?: string): SessionMeta;
  getSession(id: string): SessionMeta | undefined;
  listSessions(): SessionMeta[];
  touchSession(id: string): void;
  closeSession(id: string): boolean;
  setView(id: string, view: SessionMeta["activeView"]): void;
  attachPlugin(id: string, pluginId: string): void;
}

export type CliKind = "opencode" | "claude-code" | "pi" | "custom";

export interface CliIntegration {
  id: string;
  kind: CliKind;
  name: string;
  command: string;
  args?: string[];
  available: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface CliSession {
  id: string;
  cliId: string;
  title: string;
  status: "running" | "idle" | "done";
  startedAt: string;
}

export interface CliSessionManager {
  list(): CliSession[];
  start(cliId: string, title?: string): CliSession;
  stop(id: string): boolean;
}
