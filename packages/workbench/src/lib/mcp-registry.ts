import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";

/**
 * MCP 官方注册表（registry.modelcontextprotocol.io）只读浏览。
 *
 * 数据经 Rust mcp_registry.rs 归一后直出（serde snake_case，见 mcp_registry.rs 的
 * McpRegistryEntry）。本文件只定义消费侧类型 + 把注册表条目转换成可登记的
 * MCP server 配置草稿。登记只写 settings.mcpServers，由用户确认后启用。
 */

/** Rust mcp_registry::McpRemoteEndpoint 直出形状。 */
export interface McpRegistryRemote {
  transport: string;
  url: string;
}

/** Rust mcp_registry::McpPackageInfo 直出形状（environmentVariables 只透名字）。 */
export interface McpRegistryPackage {
  registry_type: string;
  identifier: string;
  version?: string | null;
  env_names: string[];
}

/** Rust mcp_registry::McpRegistryEntry 直出形状。 */
export interface McpRegistryEntry {
  /** 注册表唯一名："ac.inference.sh/mcp"。 */
  name: string;
  title?: string | null;
  description?: string | null;
  version?: string | null;
  repository_url?: string | null;
  status?: string | null;
  remotes: McpRegistryRemote[];
  packages: McpRegistryPackage[];
}

/** 注册表条目 → 登记草稿：可直写配置的 remote 传输 + 需要用户补的环境变量名提示。 */
export type McpRegistryDraft =
  | { ok: true; transport: "http" | "sse"; url: string; envNames: string[] }
  | { ok: false; reason: "no-remote" | "unsupported-only"; transports: string[] };

/** 注册表词汇 "streamable-http" ≡ ACP 侧 "http"（plugins/types.ts:45 的另一套命名）。 */
const HTTP_TRANSPORTS = new Set(["streamable-http", "http"]);

/**
 * 取第一个可登记的 remote：http（streamable）优先，其次 sse；stdio-only 条目
 * 仅能经 npx 等命令启动，属于 agent 运行时能力，宿主侧不登记。
 */
export function registryEntryToDraft(entry: McpRegistryEntry): McpRegistryDraft {
  const envNames = [...new Set(entry.packages.flatMap((pkg) => pkg.env_names ?? []))];
  const http = entry.remotes.find((remote) => HTTP_TRANSPORTS.has(remote.transport));
  if (http) return { ok: true, transport: "http", url: http.url, envNames };
  const sse = entry.remotes.find((remote) => remote.transport === "sse");
  if (sse) return { ok: true, transport: "sse", url: sse.url, envNames };
  return {
    ok: false,
    reason: entry.remotes.length > 0 ? "unsupported-only" : "no-remote",
    transports: entry.remotes.map((remote) => remote.transport),
  };
}

/** 搜索官方注册表。仅桌面态可用（宿主命令 mcp_search；浏览器态无代理直连）。 */
export async function searchMcpRegistry(query: string, limit = 40): Promise<McpRegistryEntry[]> {
  if (!isTauriRuntime()) {
    throw new Error("MCP registry browsing requires the desktop host");
  }
  const trimmed = query.trim();
  return invoke<McpRegistryEntry[]>("mcp_search", {
    search: trimmed || null,
    limit,
  });
}
