import type { ModelProviderConfig } from "./types";

/** ACP agent 后端配置（agent-provider 注册表项）。 */
export interface AgentProviderConfig {
  id: string;
  name: string;
  kind: "acp";
  /** ACP 启动命令（AcpAgent::from_str 兼容：可执行文件 + 参数） */
  command: string;
  enabled: boolean;
  /** PATH 上探测的可执行文件名（任一命中即视为本机已装）；空/缺省 = 不探测。 */
  detect?: string[];
  /** 未安装时的安装提示（设置页展示）。 */
  installHint?: string;
  /** 展示图标（lib/icons 图标名）；缺省由 agentProviderIcon 兜底。 */
  icon?: string;
}

/** 后端未自定义图标时的兜底。 */
export const DEFAULT_AGENT_PROVIDER_ICON = "robot";

/** 后端展示图标：用户没选就用兜底。 */
export function agentProviderIcon(provider: { icon?: string }): string {
  return provider.icon ?? DEFAULT_AGENT_PROVIDER_ICON;
}

/** ACP 预设后端对应的 @lobehub/icons 静态资源配置。 */
export interface AgentProviderLobeIcon {
  slug: string;
  /** 仅在 Lobe toc 声明 hasColor 时请求 color；否则必须请求 mono，避免 CDN 404。 */
  type: "color" | "mono";
}

const AGENT_PROVIDER_LOBE_ICON: Readonly<Record<string, AgentProviderLobeIcon>> = {
  opencode: { slug: "opencode", type: "mono" },
  codex: { slug: "codex", type: "color" },
  "claude-code": { slug: "claudecode", type: "color" },
  gemini: { slug: "geminicli", type: "color" },
  "qwen-code": { slug: "qwen", type: "color" },
  kimi: { slug: "moonshot", type: "mono" },
  glm: { slug: "chatglm", type: "color" },
  cursor: { slug: "cursor", type: "mono" },
  copilot: { slug: "githubcopilot", type: "mono" },
  goose: { slug: "goose", type: "mono" },
  amp: { slug: "amp", type: "color" },
};

/** Lobe Icons 品牌资源；用户自定义展示图标优先，因此只给未覆盖的预设返回配置。 */
export function agentProviderLobeIcon(provider: Pick<AgentProviderConfig, "id" | "icon">): AgentProviderLobeIcon | null {
  return provider.icon ? null : (AGENT_PROVIDER_LOBE_ICON[provider.id] ?? null);
}

/**
 * 主流 ACP agent 预设。
 *
 * 启动命令以官方 ACP registry（https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json）
 * 的分发信息为准：registry 给 npx 包的走 `npx -y <pkg> <args>`（免预装，首次启动按需下载），
 * 给原生二进制的走裸命令（依赖 PATH）。
 */
export const DEFAULT_AGENT_PROVIDERS: AgentProviderConfig[] = [
  {
    id: "opencode",
    name: "OpenCode",
    kind: "acp",
    command: "opencode acp",
    enabled: true,
    detect: ["opencode"],
    installHint: "opencode.ai 安装后加入 PATH",
  },
  {
    id: "codex",
    name: "Codex",
    kind: "acp",
    command: "npx -y @agentclientprotocol/codex-acp",
    enabled: false,
    detect: ["codex", "codex-acp"],
    installHint: "官方 ACP 适配器：npx 自动下载，首次启动需 Codex 登录或 OPENAI_API_KEY",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "acp",
    command: "npx -y @agentclientprotocol/claude-agent-acp",
    enabled: false,
    detect: ["claude"],
    installHint: "官方 ACP 适配器：npx 自动下载；本机需已登录 Claude Code",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    kind: "acp",
    command: "gemini --acp",
    enabled: false,
    detect: ["gemini"],
    installHint: "npm i -g @google/gemini-cli",
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    kind: "acp",
    command: "npx -y @qwen-code/qwen-code --acp",
    enabled: false,
    detect: ["qwen"],
    installHint: "npm i -g @qwen-code/qwen-code",
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    kind: "acp",
    command: "kimi acp",
    enabled: false,
    detect: ["kimi"],
    installHint: "github.com/MoonshotAI/kimi-cli releases",
  },
  {
    id: "glm",
    name: "GLM Agent（智谱）",
    kind: "acp",
    command: "npx -y glm-acp-agent",
    enabled: false,
    detect: ["glm-acp-agent"],
    installHint: "npm i -g glm-acp-agent",
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    kind: "acp",
    command: "cursor-agent acp",
    enabled: false,
    detect: ["cursor-agent"],
    installHint: "cursor.com 安装后 agent CLI 需在 PATH",
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    kind: "acp",
    command: "npx -y @github/copilot --acp",
    enabled: false,
    detect: ["copilot"],
    installHint: "npm i -g @github/copilot",
  },
  {
    id: "goose",
    name: "goose（Block）",
    kind: "acp",
    command: "goose acp",
    enabled: false,
    detect: ["goose"],
    installHint: "block.github.io/goose 安装后加入 PATH",
  },
  {
    id: "droid",
    name: "Factory Droid",
    kind: "acp",
    command: "npx -y droid exec --output-format acp-daemon",
    enabled: false,
    detect: ["droid"],
    installHint: "npm i -g droid",
  },
  {
    id: "amp",
    name: "Amp（社区 ACP 桥接）",
    kind: "acp",
    command: "npx -y amp-acp",
    enabled: false,
    detect: ["amp-acp", "amp"],
    installHint: "npm i -g amp-acp",
  },
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
