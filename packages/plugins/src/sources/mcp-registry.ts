import { invoke } from "@tauri-apps/api/core";
import type { McpServerManifest } from "../types";
import { isRecord, strField } from "./guards";

/** MCP 官方注册表条目（与 Rust mcp_registry.rs 的归一化结构对应）。 */
export interface McpRemoteEndpoint {
  transport: string;
  url: string;
}

export interface McpPackageInfo {
  registryType: string;
  identifier: string;
  version?: string;
  /** 声明的环境变量名清单（值由用户自行提供） */
  envNames: string[];
}

export interface McpRegistryEntry {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  repositoryUrl?: string;
  status?: string;
  remotes: McpRemoteEndpoint[];
  packages: McpPackageInfo[];
}

/** 登记支持的远程传输（静态表）；其余类型 Phase 1 跳过。 */
const REMOTE_TRANSPORT_TO_MANIFEST: Record<string, "streamable-http" | "sse"> = {
  "streamable-http": "streamable-http",
  sse: "sse",
};

/** 注册表唯一名转插件 id：小写、非字母数字折叠为连字符。 */
export function slugifyMcpId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `mcp-${slug || "server"}`;
}

/** 归一化 /v0/servers 响应；跳过缺 name 条目。 */
export function mapMcpServers(raw: unknown): McpRegistryEntry[] {
  if (!isRecord(raw) || !Array.isArray(raw.servers)) return [];
  const out: McpRegistryEntry[] = [];
  for (const item of raw.servers) {
    if (!isRecord(item)) continue;
    const server = isRecord(item.server) ? item.server : null;
    if (!server) continue;
    const name = strField(server, "name");
    if (!name) continue;
    out.push({
      name,
      title: strField(server, "title"),
      description: strField(server, "description"),
      version: strField(server, "version"),
      repositoryUrl: undefined,
      status: undefined,
      remotes: Array.isArray(server.remotes)
        ? server.remotes
            .filter(isRecord)
            .map((remote) => ({ transport: strField(remote, "type") ?? "", url: strField(remote, "url") ?? "" }))
            .filter((remote) => remote.transport !== "" && remote.url !== "")
        : [],
      packages: Array.isArray(server.packages)
        ? server.packages.filter(isRecord).map((pkg) => ({
            registryType: strField(pkg, "registryType") ?? "",
            identifier: strField(pkg, "identifier") ?? "",
            version: strField(pkg, "version"),
            envNames: Array.isArray(pkg.environmentVariables)
              ? pkg.environmentVariables
                  .filter(isRecord)
                  .map((envVar) => strField(envVar, "name"))
                  .filter((envName): envName is string => !!envName)
              : [],
          }))
        : [],
    });
  }
  return out;
}

/**
 * 注册表条目 → GreyWork McpServerManifest。
 * 优先远程直连（streamable-http / sse）；否则 npm 包按 stdio 登记（命令固定为
 * `npx -y <identifier>` 形状——真正 spawn 属未来运行时能力，届时仍须宿主白名单复核）。
 * 必填环境变量以 `env:NAME` 标签透出，值留空由用户后续补齐。无法安全表达时返回 null。
 */
export function toMcpServerManifest(entry: McpRegistryEntry): McpServerManifest | null {
  const base = {
    id: slugifyMcpId(entry.name),
    name: entry.title ?? entry.name,
    version: entry.version ?? "0.0.0",
    description: entry.description,
    tags: [`registry:${entry.name}`],
  };
  const remote = entry.remotes.find((candidate) => REMOTE_TRANSPORT_TO_MANIFEST[candidate.transport]);
  if (remote) {
    return {
      kind: "mcp-server",
      ...base,
      transport: REMOTE_TRANSPORT_TO_MANIFEST[remote.transport],
      url: remote.url,
    };
  }
  const npm = entry.packages.find((candidate) => candidate.registryType === "npm");
  if (npm && npm.identifier) {
    const envTags = npm.envNames.map((envName) => `env:${envName}`);
    return {
      kind: "mcp-server",
      ...base,
      tags: [...base.tags, ...envTags],
      description: npm.envNames.length ? `${entry.description ?? ""}（需环境变量：${npm.envNames.join(", ")}）`.trim() : entry.description,
      transport: "stdio",
      command: "npx",
      args: ["-y", npm.identifier],
      env: {},
    };
  }
  return null;
}

export interface McpRegistryClient {
  available(): boolean;
  search(search?: string, limit?: number): Promise<McpRegistryEntry[]>;
}

/** 桌面端经宿主代理访问官方注册表（web 运行时无通道）。 */
export function createMcpRegistryClient(): McpRegistryClient {
  return {
    available: () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
    async search(search?: string, limit?: number): Promise<McpRegistryEntry[]> {
      const raw = await invoke("mcp_search", { search: search ?? "", limit: limit ?? 20 });
      return mapMcpServers(raw);
    },
  };
}
