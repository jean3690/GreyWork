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
  /** 采样温度（0–2）；缺省不传，由服务端默认值决定。 */
  temperature?: number;
  /** 单轮最大输出 token；缺省不传。 */
  maxTokens?: number;
  /**
   * 附加请求头（自定义 baseurl 网关常见的鉴权/标记头）。
   * 值支持 `{{ENV_VAR}}` 占位符，由宿主在发请求时从环境变量解析 ——
   * 敏感值绝不随配置明文落盘；渲染端只保存占位符原文。
   */
  headers?: Record<string, string>;
  /**
   * 该供应商是否走本机 agent 回合。只读档位下工具是 read_file / list_dir / search_text /
   * git_log / git_status / git_diff；workspace 档位额外给 write_file / edit_file（每次弹确认），
   * full 档位自动放行写入。
   *
   * 缺省 false = 单轮问答。逐供应商配置而不是全局开关，因为 tool calling 是**端点/模型**
   * 的能力：有的网关不支持 `tools` 会直接 400，而同一时刻另一个供应商完全正常。
   * 工具在宿主自己的授权面内执行（复用工作区授权），不经过外部 agent。
   */
  agentMode?: boolean;
  /** agent 回合的工具调用轮数上限；缺省用宿主默认值。 */
  agentMaxRounds?: number;
}
