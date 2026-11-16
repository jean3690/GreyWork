/**
 * MCP 工具 → 本机 agent 的工具面。
 *
 * ACP 是让 agent 自己去连 MCP；本机回合没有这层，所以由宿主在每回合开始时探测一次
 * `tools/list`，把每个工具注册成模型可调的函数（名 `mcp__<server>__<tool>`），
 * 调用仍走 mcp.ts 的 mcpCall（每次一条独立会话，与 ACP 的用法一致）。
 *
 * 探测结果按「服务器配置」缓存 10 分钟：stdio 服务器冷启动要拉起 npx/uvx，
 * 每回合都探一次会让第一条回复慢到不可用；配置一变缓存 key 就变，自然失效。
 */
import { mcpCall, mcpProbe, type McpHeader, type McpToolInfo } from "./mcp.js";

export interface AgentMcpServer {
  name: string;
  transport: string;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  url?: string | null;
  headers?: McpHeader[] | null;
}

export interface McpToolBinding {
  /** 暴露给模型的工具名（已归一为 [A-Za-z0-9_-]，≤64）。 */
  toolName: string;
  server: AgentMcpServer;
  /** 服务器上的原始工具名（调用时用它，不是归一后的）。 */
  tool: string;
  description: string;
  schema: Record<string, unknown>;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_TOOL_NAME_CHARS = 64;
const cache = new Map<string, { tools: McpToolInfo[]; at: number }>();

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "x" : cleaned;
}

function toolNameFor(server: string, tool: string): string {
  const name = "mcp__" + sanitize(server) + "__" + sanitize(tool);
  return name.length <= MAX_TOOL_NAME_CHARS ? name : name.slice(0, MAX_TOOL_NAME_CHARS);
}

function cacheKey(server: AgentMcpServer): string {
  return JSON.stringify([server.transport, server.command, server.args, server.env, server.url, server.headers]);
}

async function toolsOf(server: AgentMcpServer): Promise<McpToolInfo[]> {
  const key = cacheKey(server);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tools;
  const report = await mcpProbe({
    transport: server.transport,
    url: server.url ?? null,
    command: server.command ?? null,
    args: server.args ?? null,
    env: server.env ?? null,
    headers: server.headers ?? null,
  });
  cache.set(key, { tools: report.tools, at: Date.now() });
  return report.tools;
}

/** 探测每个服务器的工具；单个服务器失败只跳过它，不影响其它服务器与本回合。 */
export async function resolveMcpTools(servers: AgentMcpServer[]): Promise<McpToolBinding[]> {
  const bindings: McpToolBinding[] = [];
  const used = new Set<string>();
  for (const server of servers) {
    let tools: McpToolInfo[];
    try {
      tools = await toolsOf(server);
    } catch (error) {
      console.warn(`[agent-mcp] 探测 ${server.name} 失败，本回合跳过: ${(error as Error).message}`);
      continue;
    }
    for (const tool of tools) {
      let toolName = toolNameFor(server.name, tool.name);
      let suffix = 1;
      while (used.has(toolName)) {
        toolName = toolNameFor(server.name, tool.name).slice(0, MAX_TOOL_NAME_CHARS - 3) + "_" + suffix;
        suffix += 1;
      }
      used.add(toolName);
      bindings.push({
        toolName,
        server,
        tool: tool.name,
        description: tool.description ?? "MCP 工具 " + tool.name + "（来自 " + server.name + "）",
        schema: normalizeSchema(tool.inputSchema),
      });
    }
  }
  return bindings;
}

/** inputSchema 原样透传；不是对象/缺 type 时补一个空对象 schema（模型至少能传空参数）。 */
function normalizeSchema(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (raw && raw.type === "object") return raw;
  return { type: "object", properties: {} };
}

/** 转成 OpenAI tools 数组；描述里带上服务器名，模型才知道这个工具从哪来。 */
export function mcpToolSchemas(bindings: McpToolBinding[]): Record<string, unknown>[] {
  return bindings.map((binding) => ({
    type: "function",
    function: {
      name: binding.toolName,
      description: "[" + binding.server.name + "] " + binding.description,
      parameters: binding.schema,
    },
  }));
}

/** 调一次 MCP 工具；返回文本与 isError（由调用方决定怎么呈现）。 */
export async function callMcpTool(binding: McpToolBinding, args: unknown): Promise<{ text: string; isError: boolean }> {
  const report = await mcpCall({
    transport: binding.server.transport,
    url: binding.server.url ?? null,
    command: binding.server.command ?? null,
    args: binding.server.args ?? null,
    env: binding.server.env ?? null,
    headers: binding.server.headers ?? null,
    tool: binding.tool,
    arguments: args,
  });
  return { text: report.text, isError: report.isError };
}
