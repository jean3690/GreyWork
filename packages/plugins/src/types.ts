export type PluginKind = "skill" | "extension" | "mcp-server";

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface PluginBase {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: PluginAuthor;
  tags?: string[];
}

/** 标准化 Skill：可被 Agent 按需加载的指令/能力包 */
export interface SkillManifest extends PluginBase {
  kind: "skill";
  entry: string;
  tools?: string[];
  modelProviderHint?: string;
}

/** 标准化 Extension：UI、连接器或渲染器等扩展 */
export interface ExtensionManifest extends PluginBase {
  kind: "extension";
  type: "ui" | "backend" | "connector" | "renderer" | "data-source";
  entry: string;
  permissions?: string[];
  contributes?: {
    commands?: string[];
    panels?: string[];
    modelProviders?: string[];
    tools?: string[];
    views?: string[];
    fileTypes?: string[];
  };
}

/** MCP 服务配置（stdio / streamable-http / sse） */
export interface McpServerManifest extends PluginBase {
  kind: "mcp-server";
  transport: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export type PluginManifest = SkillManifest | ExtensionManifest | McpServerManifest;

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools?: string[];
  hooks?: {
    beforeRun?: string;
    afterRun?: string;
  };
}

export interface CommandDecision {
  allowed: boolean;
  requiresApproval?: boolean;
  reason?: string;
}

/** AI 可执行命令的策略：允许/拒绝/需要人工审批 */
export interface CommandPolicy {
  defaultAction: "allow" | "deny";
  allow?: string[];
  deny?: string[];
  requireApproval?: string[];
}

export interface CommandGuard {
  allowCommand(command: string): CommandDecision;
  setPolicy(policy: CommandPolicy): void;
  getPolicy(): CommandPolicy;
}
