import type {
  AcpClient,
  AcpEventEnvelope,
  AcpPermissionOptionInfo,
  AcpPermissionRequestPayload,
  AcpPromptResult,
  AcpSandboxMode,
  AcpSessionConfigOption,
  AcpSessionOpened,
  PermissionTier,
} from "@greywork/acp";

/**
 * ACP-native 适配器：session/stream/permission 语义与既有 IntegrationAdapter
 * （issue/chat 形态）不匹配，故独立接口，不硬塞进 IntegrationProviderId。
 */
export interface AcpAgentAdapter {
  provider: "acp";
  isAvailable(): boolean;
  startAgent(agentCmd: string, tier: PermissionTier, sandbox?: AcpSandboxMode, workspace?: string | null): Promise<number>;
  openSession(handle: number, cwd: string): Promise<AcpSessionOpened>;
  setSessionConfig(handle: number, configId: string, value: string | boolean): Promise<AcpSessionConfigOption[]>;
  prompt(handle: number, text: string): Promise<AcpPromptResult>;
  stop(handle: number): Promise<void>;
  respondPermission(requestId: number, optionId: string | null): Promise<void>;
  onEvent(listener: (event: AcpEventEnvelope) => void): Promise<() => void>;
}

/** 组合任意 AcpClient（传输差异已在 @greywork/acp 内隔离）。 */
export function createAcpAgentAdapter(client: AcpClient): AcpAgentAdapter {
  return {
    provider: "acp",
    isAvailable: () => client.isAvailable(),
    startAgent: (agentCmd, tier, sandbox, workspace) => client.startAgent(agentCmd, tier, sandbox, workspace),
    openSession: (handle, cwd) => client.openSession(handle, cwd),
    setSessionConfig: (handle, configId, value) => client.setSessionConfig(handle, configId, value),
    prompt: (handle, text) => client.prompt(handle, text),
    stop: (handle) => client.stop(handle),
    respondPermission: (requestId, optionId) => client.respondPermission(requestId, optionId),
    onEvent: (listener) => client.onEvent(listener),
  };
}

export type { AcpPermissionOptionInfo, AcpPermissionRequestPayload };
