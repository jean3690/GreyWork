/** ACP 传输抽象：desktop 走 Tauri IPC（Rust 主机），web 走远程 WebSocket。 */

import { isTauriRuntime } from "@greywork/core";
import type { PermissionTier } from "./permissions";

export { isTauriRuntime };

export interface AcpEventEnvelope {
  kind: string;
  payload: unknown;
}

export interface AcpSessionInfo {
  handle: number;
  command: string;
  hasSession: boolean;
}

/** 沙盒档位：off 直启；fs = 文件系统隔离 + 网络关闭；full = 隔离 + 网络放行。 */
export type AcpSandboxMode = "off" | "fs" | "full";

export interface AcpPromptResult {
  stopReason?: string;
  [key: string]: unknown;
}

/** 会话级配置选择器选项（select 型的候选值）。 */
export interface AcpConfigOptionChoice {
  value: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * agent 在 session/new 暴露的会话级配置选择器（模型 / 推理力度 / 会话模式等）。
 * 仅消费 select 型；boolean 型保留 type 字段以便透传展示。
 */
export interface AcpSessionConfigOption {
  id: string;
  name: string;
  category?: string;
  type: "select" | "boolean" | (string & {});
  currentValue?: string | boolean | null;
  options?: AcpConfigOptionChoice[];
  [key: string]: unknown;
}

/**
 * 一台 MCP 服务器的声明。随 `session/new` 交给 agent，**由 agent 去连接**，
 * 工具并入它自己的工具面；宿主不代理工具调用。
 *
 * `http` / `sse` 需要 agent 在 initialize 里声明对应能力，否则该台会被跳过；
 * `stdio` 是协议要求所有 agent 都支持的传输。
 */
export interface McpServerConfig {
  name: string;
  transport: "http" | "sse" | "stdio";
  /** http / sse 传输的端点。 */
  url?: string;
  /** http / sse 的请求头（鉴权等）。 */
  headers?: Array<{ name: string; value: string }>;
  /** stdio 传输的可执行文件绝对路径。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** 被跳过的服务器：reason 形如 `http_unsupported` / `missing_url` / `unknown_transport:x`。 */
export interface McpSkippedServer {
  name: string;
  reason: string;
}

export interface McpToolInfo {
  name: string;
  description?: string | null;
}

/** 探活报告（设置页「测试连接」）：服务器自述 + 工具清单。 */
export interface McpProbeReport {
  transport: string;
  serverName?: string | null;
  serverVersion?: string | null;
  tools: McpToolInfo[];
  durationMs: number;
}

/** acp_new_session 返回：会话 id + 初始配置选项 + MCP 声明结果。 */
export interface AcpSessionOpened {
  sessionId: string;
  configOptions: AcpSessionConfigOption[];
  /** 实际声明给 agent 的服务器名。 */
  mcpServers?: string[];
  /** 因能力不匹配 / 配置不全被跳过的服务器。 */
  skippedMcpServers?: McpSkippedServer[];
}

/** 权限请求载荷（宿主 permission-request / permission-auto 事件的 payload）。 */
export interface AcpPermissionOptionInfo {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface AcpPermissionRequestPayload {
  requestId: number;
  /** true = 宿主按档位自动决策，仅作通知流展示 */
  auto: boolean;
  chosen: string | null;
  toolCallId: string;
  title?: string | null;
  kind: string;
  options: AcpPermissionOptionInfo[];
}

export interface AcpTransport {
  readonly id: "tauri-ipc" | "websocket";
  /** Web transports are available only after an endpoint is configured. */
  readonly available?: boolean;
  /** sandbox 非 off 时宿主以 OS 沙盒包裹 agent；workspace 为沙盒可写锚定目录（桌面端必需）。 */
  startAgent(agentCmd: string, tier: PermissionTier, sandbox?: AcpSandboxMode, workspace?: string | null): Promise<number>;
  /**
   * 改写在途会话的权限档位（临时降级/回升）。桌面宿主按 handle 存档位并在每条
   * 权限请求上重新读取，因此改档立即生效、不必重启 agent 进程。
   */
  setPermissionTier(handle: number, tier: PermissionTier): Promise<void>;
  /** 建会话；`mcpServers` 随 session/new 声明给 agent（能力不匹配的由宿主跳过并回报）。 */
  openSession(handle: number, cwd: string, mcpServers?: readonly McpServerConfig[]): Promise<AcpSessionOpened>;
  /** 设置会话配置选项（select 传字符串值，boolean 传布尔值）；返回全量最新配置选项。 */
  setSessionConfig(handle: number, configId: string, value: string | boolean): Promise<AcpSessionConfigOption[]>;
  /** 发送一轮 prompt，立即返回 turnId；回合结果经 `prompt-done` 事件送达。 */
  prompt(handle: number, text: string): Promise<{ turnId: number }>;
  /** 停止：传 turnId 仅取消该回合（agent 进程保留）；缺省停止整个会话。 */
  stop(handle: number, turnId?: number): Promise<void>;
  respondPermission(requestId: number, optionId: string | null): Promise<void>;
  list(): Promise<AcpSessionInfo[]>;
  onEvent(listener: (event: AcpEventEnvelope) => void): Promise<() => void>;
  /** 探活一台 MCP 服务器（设置页「测试连接」）：initialize + tools/list。 */
  probeMcp(config: McpServerConfig, timeoutSecs?: number): Promise<McpProbeReport>;
}
