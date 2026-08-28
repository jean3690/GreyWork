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

/** acp_new_session 返回：会话 id + 初始配置选项。 */
export interface AcpSessionOpened {
  sessionId: string;
  configOptions: AcpSessionConfigOption[];
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
  openSession(handle: number, cwd: string): Promise<AcpSessionOpened>;
  /** 设置会话配置选项（select 传字符串值，boolean 传布尔值）；返回全量最新配置选项。 */
  setSessionConfig(handle: number, configId: string, value: string | boolean): Promise<AcpSessionConfigOption[]>;
  prompt(handle: number, text: string): Promise<AcpPromptResult>;
  stop(handle: number): Promise<void>;
  respondPermission(requestId: number, optionId: string | null): Promise<void>;
  list(): Promise<AcpSessionInfo[]>;
  onEvent(listener: (event: AcpEventEnvelope) => void): Promise<() => void>;
}
