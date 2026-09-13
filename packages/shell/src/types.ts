export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "max";

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
