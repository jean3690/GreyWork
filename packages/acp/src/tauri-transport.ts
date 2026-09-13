import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AcpEventEnvelope,
  AcpPromptUnit,
  AcpSandboxMode,
  AcpSessionConfigOption,
  AcpSessionInfo,
  AcpSessionOpened,
  AcpTransport,
  McpProbeReport,
  McpServerConfig,
} from "./transports";
import type { PermissionTier } from "./permissions";

const EVENT_NAME = "acp://event";

/** 桌面端传输：经 Tauri IPC 调用 Rust ACP 主机（acp_host.rs）。 */
export class TauriIpcTransport implements AcpTransport {
  readonly id = "tauri-ipc" as const;

  async startAgent(agentCmd: string, tier: PermissionTier, sandbox?: AcpSandboxMode, workspace?: string | null): Promise<number> {
    return invoke<number>("acp_start", { agentCmd, tier, sandbox, workspace });
  }

  async setPermissionTier(handle: number, tier: PermissionTier): Promise<void> {
    await invoke("acp_set_permission_tier", { handle, tier });
  }

  async openSession(handle: number, cwd: string, mcpServers?: readonly McpServerConfig[]): Promise<AcpSessionOpened> {
    return invoke<AcpSessionOpened>("acp_new_session", { handle, cwd, mcpServers });
  }

  async loadSession(handle: number, cwd: string, sessionId: string, mcpServers?: readonly McpServerConfig[]): Promise<AcpSessionOpened> {
    return invoke<AcpSessionOpened>("acp_load_session", { handle, cwd, sessionId, mcpServers });
  }

  async probeMcp(config: McpServerConfig, timeoutSecs?: number): Promise<McpProbeReport> {
    return invoke<McpProbeReport>("mcp_probe", {
      transport: config.transport,
      url: config.url,
      command: config.command,
      args: config.args,
      env: config.env,
      headers: config.headers,
      timeoutSecs,
    });
  }

  async setSessionConfig(handle: number, configId: string, value: string | boolean): Promise<AcpSessionConfigOption[]> {
    const response = await invoke<{ configOptions?: AcpSessionConfigOption[] }>("acp_set_config", {
      handle,
      configId,
      value,
    });
    return response.configOptions ?? [];
  }

  async prompt(handle: number, text: string, units: readonly AcpPromptUnit[] = []): Promise<{ turnId: number }> {
    return invoke<{ turnId: number }>("acp_send", { handle, text, units });
  }

  async stop(handle: number, turnId?: number): Promise<void> {
    await invoke("acp_stop", { handle, turnId });
  }

  async respondPermission(requestId: number, optionId: string | null): Promise<void> {
    await invoke("acp_permission_respond", { requestId, optionId });
  }

  async list(): Promise<AcpSessionInfo[]> {
    return invoke<AcpSessionInfo[]>("acp_list");
  }

  async onEvent(listener: (event: AcpEventEnvelope) => void): Promise<() => void> {
    const unlisten: UnlistenFn = await listen<AcpEventEnvelope>(EVENT_NAME, (event) => {
      listener(event.payload);
    });
    return () => unlisten();
  }
}
