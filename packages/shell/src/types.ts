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
  /**
   * 附加请求头（自定义 baseurl 网关常见的鉴权/标记头）。
   * 值支持 `{{ENV_VAR}}` 占位符，由宿主在发请求时从环境变量解析 ——
   * 敏感值绝不随配置明文落盘；渲染端只保存占位符原文。
   */
  headers?: Record<string, string>;
}
