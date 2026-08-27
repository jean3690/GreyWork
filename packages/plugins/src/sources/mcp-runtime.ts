import { invoke } from "@tauri-apps/api/core";

/** MCP 探活报告（与 Rust mcp_client.rs 的 McpProbeReport 对应）。 */
export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpProbeReport {
  transport: "stdio" | "remote";
  serverName?: string;
  serverVersion?: string;
  tools: McpToolInfo[];
  durationMs: number;
}

/** 桌面端 MCP 运行时探活通道：仅握手验证，不执行工具调用。 */
export interface McpRuntimeClient {
  available(): boolean;
  probeStdio(command: string, args: string[], env?: Record<string, string>, timeoutSecs?: number): Promise<McpProbeReport>;
  probeRemote(url: string, timeoutSecs?: number): Promise<McpProbeReport>;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createMcpRuntimeClient(): McpRuntimeClient {
  return {
    available(): boolean {
      return isTauriRuntime();
    },
    probeStdio(command, args, env?, timeoutSecs?): Promise<McpProbeReport> {
      return invoke("mcp_probe_stdio", { command, args, env, timeoutSecs });
    },
    probeRemote(url: string, timeoutSecs?: number): Promise<McpProbeReport> {
      return invoke("mcp_probe_remote", { url, timeoutSecs });
    },
  };
}
