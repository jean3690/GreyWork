import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AcpEventEnvelope,
  AcpPromptResult,
  AcpSessionConfigOption,
  AcpSessionInfo,
  AcpSessionOpened,
  AcpTransport,
} from "./transports";
import type { PermissionTier } from "./permissions";

const EVENT_NAME = "acp://event";

/** 桌面端传输：经 Tauri IPC 调用 Rust ACP 主机（acp_host.rs）。 */
export class TauriIpcTransport implements AcpTransport {
  readonly id = "tauri-ipc" as const;

  async startAgent(agentCmd: string, tier: PermissionTier): Promise<number> {
    return invoke<number>("acp_start", { agentCmd, tier });
  }

  async openSession(handle: number, cwd: string): Promise<AcpSessionOpened> {
    return invoke<AcpSessionOpened>("acp_new_session", { handle, cwd });
  }

  async setSessionConfig(handle: number, configId: string, value: string | boolean): Promise<AcpSessionConfigOption[]> {
    const response = await invoke<{ configOptions?: AcpSessionConfigOption[] }>("acp_set_config", {
      handle,
      configId,
      value,
    });
    return response.configOptions ?? [];
  }

  async prompt(handle: number, text: string): Promise<AcpPromptResult> {
    return invoke<AcpPromptResult>("acp_send", { handle, text });
  }

  async stop(handle: number): Promise<void> {
    await invoke("acp_stop", { handle });
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
