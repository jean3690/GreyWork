import type { ModelProviderConfig, WebSearchProviderConfig } from "./types";

/** ACP agent 后端配置（agent-provider 注册表项）。 */
export interface AgentProviderConfig {
  id: string;
  name: string;
  kind: "acp";
  /** ACP 启动命令（AcpAgent::from_str 兼容：可执行文件 + 参数） */
  command: string;
  enabled: boolean;
}

export const DEFAULT_AGENT_PROVIDERS: AgentProviderConfig[] = [
  { id: "opencode", name: "OpenCode", kind: "acp", command: "opencode acp", enabled: true },
  {
    id: "mock-agent",
    name: "Mock Agent（本地桩）",
    kind: "acp",
    command: "node apps/desktop/src-tauri/tests/mock-acp-agent.mjs",
    enabled: true,
  },
  { id: "codex", name: "Codex", kind: "acp", command: "codex acp", enabled: false },
  { id: "claude-code", name: "Claude Code（zed 桥接）", kind: "acp", command: "npx -y @zed-industries/claude-code-acp", enabled: false },
];

export const DEFAULT_MODEL_PROVIDERS: ModelProviderConfig[] = [
  {
    id: "openai-compatible",
    name: "OpenAI Compatible",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    apiKeyEnv: "OPENAI_API_KEY",
    enabled: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    enabled: true,
  },
  { id: "ollama", name: "Ollama 本地", kind: "ollama", baseUrl: "http://localhost:11434", model: "qwen2.5", enabled: false },
  { id: "custom", name: "自定义供应商", kind: "custom", baseUrl: "", model: "", apiKeyEnv: "CUSTOM_LLM_API_KEY", enabled: false },
];

export const DEFAULT_WEB_SEARCH_PROVIDERS: WebSearchProviderConfig[] = [
  { id: "tavily", name: "Tavily", endpoint: "https://api.tavily.com/search", apiKeyEnv: "TAVILY_API_KEY", enabled: true },
  {
    id: "brave",
    name: "Brave Search",
    endpoint: "https://api.search.brave.com/res/v1/web/search",
    apiKeyEnv: "BRAVE_API_KEY",
    enabled: false,
  },
  { id: "custom", name: "自定义搜索", endpoint: "", apiKeyEnv: "CUSTOM_SEARCH_API_KEY", enabled: false },
];

export function createModelProviderRegistry() {
  const providers = new Map(DEFAULT_MODEL_PROVIDERS.map((p) => [p.id, p]));
  return {
    list() {
      return Array.from(providers.values());
    },
    get(id: string) {
      return providers.get(id);
    },
    set(provider: ModelProviderConfig) {
      if (!provider.id) throw new Error("provider.id is required");
      providers.set(provider.id, provider);
    },
  };
}

export function createWebSearchProviderRegistry() {
  const providers = new Map(DEFAULT_WEB_SEARCH_PROVIDERS.map((p) => [p.id, p]));
  return {
    list() {
      return Array.from(providers.values());
    },
    get(id: string) {
      return providers.get(id);
    },
    set(provider: WebSearchProviderConfig) {
      if (!provider.id) throw new Error("provider.id is required");
      providers.set(provider.id, provider);
    },
  };
}

/** ACP agent 后端注册表（与 ModelProviderRegistry 同构）。 */
export function createAgentProviderRegistry() {
  const providers = new Map(DEFAULT_AGENT_PROVIDERS.map((p) => [p.id, p]));
  return {
    list() {
      return Array.from(providers.values());
    },
    get(id: string) {
      return providers.get(id);
    },
    set(provider: AgentProviderConfig) {
      if (!provider.id) throw new Error("provider.id is required");
      if (provider.kind !== "acp") throw new Error("agent provider kind must be 'acp'");
      providers.set(provider.id, provider);
    },
  };
}
