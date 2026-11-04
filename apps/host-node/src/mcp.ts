/**
 * MCP 客户端（探活 + 工具调用）与官方注册表代理：移植 `crates/greywork-host/src/services/mcp.rs`
 * 与 `services/mcp_registry.rs`、`services/plugin_market/plugin_mcp.rs`。
 *
 * 边界与 Rust 一致：连接由 agent 建立时宿主不插手；这里的客户端只服务设置页「测试连接」
 * 与插件 mcp.connect 代理。stdio 帧是换行分隔 JSON-RPC 2.0（非 LSP）；remote 走
 * Streamable HTTP（POST，回包可能是整段 JSON 或 SSE `data:` 行）。
 *
 * SSRF 决策同 Rust：单用户桌面端，URL 由用户自己填，不做内网过滤。
 */
import { spawn } from "node:child_process";
import path from "node:path";

/** MCP stdio 探活允许的运行时入口（basename），与 Rust `ALLOWED_MCP_RUNTIMES` 同名单。 */
export const ALLOWED_MCP_RUNTIMES = new Set(["npx", "bunx", "uvx", "node"]);

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_PROBE_TIMEOUT_SECS = 45;
const CLIENT_NAME = "greywork";
/** 正文文本的宿主侧硬上限（按字符截断，中文不会切坏 UTF-8）。 */
const CALL_TEXT_MAX_CHARS = 16 * 1024;
const MAX_TOOL_NAME_CHARS = 128;

export interface McpHeader {
  name: string;
  value: string;
}

export interface McpToolInfo {
  name: string;
  description?: string | null;
}

export interface McpProbeReport {
  transport: string;
  serverName?: string | null;
  serverVersion?: string | null;
  tools: McpToolInfo[];
  durationMs: number;
}

export interface McpCallReport {
  transport: string;
  isError: boolean;
  text: string;
  content: unknown;
  durationMs: number;
}

export interface McpCallArgs {
  transport: string;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  headers?: McpHeader[] | null;
  tool: string;
  arguments?: unknown;
  timeoutSecs?: number | null;
}

/** 这些字符出现在启动串里即拒绝（Rust `process_guard::SHELL_META_CHARS` 同名单）。 */
const SHELL_META_CHARS = /[|&;<>$`()\n\r]/;

/** spawn 命令校验（Rust `validate_spawn_command` 的 stdio-mcp 口径）。 */
function validateSpawnCommand(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("spawn command is empty");
  const found = [...trimmed].find((c) => SHELL_META_CHARS.test(c));
  if (found !== undefined) {
    throw new Error(`spawn command contains forbidden character ${JSON.stringify(found)}`);
  }
  const program = trimmed.split(/\s+/)[0] ?? "";
  const basename = path.basename(program);
  if (program !== basename && !path.isAbsolute(program)) {
    throw new Error(`spawn program must be a bare name or absolute path: ${program}`);
  }
  if (!ALLOWED_MCP_RUNTIMES.has(basename)) {
    throw new Error(`spawn program '${basename}' is not in the allowed list`);
  }
  return trimmed;
}

function rpcRequest(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

function rpcNotification(method: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method })}\n`;
}

function initParams(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: "0.1.0" },
  };
}

/** 从响应块提取所有 `data:` 行的 JSON（Streamable HTTP 可能以 SSE 回包）。 */
function parseSseData(chunk: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "") continue;
    try {
      values.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      // 忽略非 JSON 行。
    }
  }
  return values;
}

function responseFor(lines: Record<string, unknown>[], id: number): Record<string, unknown> | undefined {
  return lines.find((line) => line.id === id && line.result !== undefined);
}

/** 响应体先按整段 JSON 试，失败则按 SSE `data:` 行提取后找匹配 id 的 result。 */
function parseBodyResult(body: string, id: number): Record<string, unknown> {
  try {
    const envelope = JSON.parse(body.trim()) as Record<string, unknown>;
    if (envelope.result !== undefined) return envelope.result as Record<string, unknown>;
    if (envelope.error !== undefined) throw new Error(`mcp server error: ${JSON.stringify(envelope.error)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("mcp server error:")) throw error;
  }
  for (const value of parseSseData(body)) {
    if (responseFor([value], id) !== undefined) return value.result as Record<string, unknown>;
    if (value.error !== undefined) throw new Error(`mcp server error: ${JSON.stringify(value.error)}`);
  }
  throw new Error("no matching JSON-RPC response in remote reply");
}

function extractTools(result: Record<string, unknown>): McpToolInfo[] {
  const tools = result.tools as { name?: unknown; description?: unknown }[] | undefined;
  if (!Array.isArray(tools)) return [];
  const out: McpToolInfo[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== "string") continue;
    out.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : null,
    });
  }
  return out;
}

function headerRecord(headers: McpHeader[] | null | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of headers ?? []) {
    const name = header.name.trim();
    const value = header.value.trim();
    if (name === "" || value === "") continue;
    map[name] = value;
  }
  return map;
}

/** 一次 Streamable HTTP 会话：`initialize` 拿会话 id，之后的请求都带它。 */
class HttpSession {
  private readonly auth: Record<string, string>;

  private constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    auth: Record<string, string>,
    private readonly sessionId: string | null,
    readonly initResult: Record<string, unknown>,
  ) {
    this.auth = auth;
  }

  static async open(url: string, headers: McpHeader[], timeoutSecs: number): Promise<HttpSession> {
    const lower = url.toLowerCase();
    if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
      throw new Error(`mcp url must be http(s), got: ${url}`);
    }
    const timeoutMs = timeoutSecs * 1000;
    const auth = headerRecord(headers);
    const response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", ...auth },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initParams() }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error: Error) => {
      throw new Error(`initialize request failed: ${error.message}`);
    });
    if (!response.ok) throw new Error(`initialize returned HTTP ${response.status}`);
    const sessionId = response.headers.get("Mcp-Session-Id");
    const body = await response.text().catch((error: Error) => {
      throw new Error(`failed to read body: ${error.message}`);
    });
    const initResult = parseBodyResult(body, 1);
    const session = new HttpSession(url, timeoutMs, auth, sessionId, initResult);
    // initialized 是 notification：无 id、无回包；失败不阻断后续请求。
    await session.notify("notifications/initialized");
    return session;
  }

  private withSession(headers: Record<string, string>): Record<string, string> {
    return this.sessionId ? { ...headers, "Mcp-Session-Id": this.sessionId } : headers;
  }

  async request(id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.withSession({ accept: "application/json, text/event-stream", ...this.auth }),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: Error) => {
      throw new Error(`${method} request failed: ${error.message}`);
    });
    if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
    const body = await response.text().catch((error: Error) => {
      throw new Error(`failed to read body: ${error.message}`);
    });
    return parseBodyResult(body, id);
  }

  private async notify(method: string): Promise<void> {
    await fetch(this.url, {
      method: "POST",
      headers: this.withSession({ ...this.auth }),
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch(() => undefined);
  }
}

/** 归一化 `tools/call` 的 result：拼 text 条目、取 isError、原样带回 content 数组。 */
function normalizeCallResult(result: Record<string, unknown>): { isError: boolean; text: string; content: unknown } {
  const isError = result.isError === true;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item): item is { type: string; text: string } => (item as { type?: unknown })?.type === "text")
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
  return { isError, text: truncateChars(text, CALL_TEXT_MAX_CHARS), content };
}

/** 按字符截断（不是字节）：中文正文按字节切会把 UTF-8 尾巴切坏。 */
function truncateChars(text: string, max: number): string {
  if ([...text].length <= max) return text;
  return [...text].slice(0, max).join("") + "…";
}

/** 一次 stdio 会话：spawn → initialize → initialized → 后续请求；结束整树回收。 */
class StdioSession {
  private readonly proc: ReturnType<typeof spawn>;
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private exited = false;
  initResult: Record<string, unknown> = {};

  private constructor(proc: ReturnType<typeof spawn>) {
    this.proc = proc;
    proc.stdout?.setEncoding("utf8");
    let lineBuffer = "";
    proc.stdout?.on("data", (chunk: string) => {
      lineBuffer += chunk;
      let newline = lineBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        newline = lineBuffer.indexOf("\n");
        if (line === "") continue;
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const id = typeof message.id === "number" ? message.id : null;
        if (id === null) continue;
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        if (message.error !== undefined) {
          pending.reject(new Error(`mcp server error: ${JSON.stringify(message.error)}`));
        } else {
          pending.resolve(message.result as Record<string, unknown>);
        }
      }
    });
    proc.on("exit", () => {
      this.exited = true;
      for (const pending of this.pending.values()) pending.reject(new Error("mcp server exited"));
      this.pending.clear();
    });
    proc.on("error", (error: Error) => {
      this.exited = true;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  static async open(command: string, args: string[], env: Record<string, string> | null): Promise<StdioSession> {
    const validated = validateSpawnCommand(command);
    for (const arg of args) {
      if (SHELL_META_CHARS.test(arg)) {
        throw new Error(`mcp arg contains forbidden character: ${JSON.stringify(arg)}`);
      }
    }
    // Windows 上 npx/bunx 是 .cmd 垫片，CreateProcess 起不来：改由 cmd.exe 承载裸程序名。
    const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(validated);
    const envs: Record<string, string> = { ...(env ?? {}) };
    if (!Object.hasOwn(envs, "PATH")) envs.PATH = process.env.PATH ?? "";
    const proc = spawn(isBatch ? "cmd" : validated, isBatch ? ["/C", validated, ...args] : args, {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...envs },
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const session = new StdioSession(proc);
    session.initResult = await session.request(1, "initialize", initParams());
    // initialized 是 notification：无 id，无需等回包。
    proc.stdin?.write(rpcNotification("notifications/initialized"));
    return session;
  }

  request(id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(new Error("mcp server exited"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin?.write(rpcRequest(id, method, params), (error?: Error | null) => {
        if (error) {
          this.pending.delete(id);
          reject(new Error(`failed to write to mcp server: ${error.message}`));
        }
      });
    });
  }

  kill(): void {
    try {
      if (process.platform === "win32") this.proc.kill();
      else process.kill(-this.proc.pid!, "SIGKILL");
    } catch {
      // 已退出。
    }
    try {
      this.proc.kill("SIGKILL");
    } catch {
      // 兜底。
    }
  }
}

/** 工具调用：`tools/call`。`arguments` 必须是 JSON 对象（MCP 要求）。 */
export async function mcpCall(request: McpCallArgs): Promise<McpCallReport> {
  const { transport, url, command, args, env, headers, timeoutSecs } = request;
  const tool = request.tool.trim();
  if (tool === "") throw new Error("mcp_call requires a non-empty tool name");
  if ([...tool].length > MAX_TOOL_NAME_CHARS) {
    throw new Error(`mcp_call tool name exceeds ${MAX_TOOL_NAME_CHARS} characters`);
  }
  let callArguments: Record<string, unknown>;
  if (request.arguments === undefined || request.arguments === null) {
    callArguments = {};
  } else if (typeof request.arguments === "object" && !Array.isArray(request.arguments)) {
    callArguments = request.arguments as Record<string, unknown>;
  } else {
    throw new Error("mcp_call arguments must be a JSON object");
  }
  const params = { name: tool, arguments: callArguments };
  const timeout = timeoutSecs ?? DEFAULT_PROBE_TIMEOUT_SECS;

  const started = Date.now();
  if (transport === "http") {
    if (!url) throw new Error("http transport requires url");
    const session = await HttpSession.open(url, headers ?? [], timeout);
    const result = await session.request(2, "tools/call", params);
    const { isError, text, content } = normalizeCallResult(result);
    return { transport: "http", isError, text, content, durationMs: Date.now() - started };
  }
  if (transport === "stdio") {
    if (!command) throw new Error("stdio transport requires command");
    const session = await StdioSession.open(command, args ?? [], env ?? null);
    try {
      const result = await session.request(2, "tools/call", params);
      const { isError, text, content } = normalizeCallResult(result);
      return { transport: "stdio", isError, text, content, durationMs: Date.now() - started };
    } finally {
      session.kill();
    }
  }
  if (transport === "sse") {
    throw new Error("sse transport cannot be called; declare it and let the agent connect");
  }
  throw new Error(`unknown mcp transport: ${transport}`);
}

/** 探活一台 MCP 服务器：`initialize` + `tools/list`，返回服务器信息与工具清单。 */
export async function mcpProbe(request: {
  transport: string;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  headers?: McpHeader[] | null;
  timeoutSecs?: number | null;
}): Promise<McpProbeReport> {
  const { transport, url, command, args, env, headers, timeoutSecs } = request;
  const timeout = timeoutSecs ?? DEFAULT_PROBE_TIMEOUT_SECS;
  const started = Date.now();
  if (transport === "http") {
    if (!url) throw new Error("http transport requires url");
    const session = await HttpSession.open(url, headers ?? [], timeout);
    const serverInfo = session.initResult as { serverInfo?: { name?: unknown; version?: unknown } };
    const listResult = await session.request(2, "tools/list", {});
    return {
      transport: "http",
      serverName: typeof serverInfo.serverInfo?.name === "string" ? serverInfo.serverInfo.name : null,
      serverVersion: typeof serverInfo.serverInfo?.version === "string" ? serverInfo.serverInfo.version : null,
      tools: extractTools(listResult),
      durationMs: Date.now() - started,
    };
  }
  if (transport === "stdio") {
    if (!command) throw new Error("stdio transport requires command");
    const session = await StdioSession.open(command, args ?? [], env ?? null);
    try {
      const serverInfo = session.initResult as { serverInfo?: { name?: unknown; version?: unknown } };
      const listResult = await session.request(2, "tools/list", {});
      return {
        transport: "stdio",
        serverName: typeof serverInfo.serverInfo?.name === "string" ? serverInfo.serverInfo.name : null,
        serverVersion: typeof serverInfo.serverInfo?.version === "string" ? serverInfo.serverInfo.version : null,
        tools: extractTools(listResult),
        durationMs: Date.now() - started,
      };
    } finally {
      session.kill();
    }
  }
  if (transport === "sse") {
    throw new Error("sse transport cannot be probed; declare it and let the agent connect");
  }
  throw new Error(`unknown mcp transport: ${transport}`);
}

/* ===== 插件 mcp.connect 代理（plugin_mcp.rs 移植） ===== */

/** 单次 arguments 序列化后的字节上限：插件传的是工具参数，不是文件内容。 */
export const MAX_PLUGIN_MCP_ARGUMENT_BYTES = 16 * 1024;
const MAX_ALLOWED_TOOLS = 16;
const MAX_TOOL_CHARS = 128;
const MAX_SERVER_NAME_CHARS = 64;
const DEFAULT_PLUGIN_TIMEOUT_SECS = 30;
const MAX_PLUGIN_TIMEOUT_SECS = 60;

export interface PluginMcpCallRequest {
  pluginId: string;
  server: string;
  transport: string;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  headers?: McpHeader[] | null;
  tool: string;
  arguments?: unknown;
  allowedTools: string[];
  timeoutSecs?: number | null;
}

/** 标识校验（Rust `validate_key` 同口径：安全字符集，可作路径/日志成分）。 */
function validateKey(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
}

export interface PluginMcpCallResponse {
  transport: string;
  isError: boolean;
  text: string;
  durationMs: number;
}

/** 插件 mcp.connect 的宿主侧门面：白名单复核 + 配额，连接参数由渲染端 broker 传入。 */
export async function pluginMcpCall(request: PluginMcpCallRequest): Promise<PluginMcpCallResponse> {
  validateKey(request.pluginId, "plugin id");
  const server = request.server.trim();
  if (server === "") throw new Error("mcp.connect requires a server name");
  if ([...server].length > MAX_SERVER_NAME_CHARS) {
    throw new Error(`mcp.connect server name exceeds ${MAX_SERVER_NAME_CHARS} characters`);
  }
  if ([...server].some((c) => /\p{C}/u.test(c))) {
    throw new Error("mcp.connect server name must not contain control characters");
  }
  if (request.allowedTools.length === 0 || request.allowedTools.length > MAX_ALLOWED_TOOLS) {
    throw new Error(`mcp.connect requires an allowlist of 1-${MAX_ALLOWED_TOOLS} tools`);
  }
  const tool = request.tool.trim();
  if (tool === "") throw new Error("mcp.connect requires a non-empty tool name");
  if ([...tool].length > MAX_TOOL_CHARS) {
    throw new Error(`mcp.connect tool name exceeds ${MAX_TOOL_CHARS} characters`);
  }
  if (!request.allowedTools.some((allowed) => allowed.trim() === tool)) {
    throw new Error(`mcp.connect tool not allowed by the manifest: ${tool} (server ${server})`);
  }
  if (request.arguments !== undefined && request.arguments !== null) {
    if (typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
      throw new Error("mcp.connect arguments must be a JSON object");
    }
    const bytes = Buffer.byteLength(JSON.stringify(request.arguments), "utf8");
    if (bytes > MAX_PLUGIN_MCP_ARGUMENT_BYTES) {
      throw new Error(`mcp.connect arguments exceed ${MAX_PLUGIN_MCP_ARGUMENT_BYTES} bytes (server ${server})`);
    }
  }
  if (request.transport === "sse") {
    throw new Error("mcp.connect cannot proxy sse servers; declare them for the agent instead");
  }
  if (request.transport !== "http" && request.transport !== "stdio") {
    throw new Error(`unknown mcp transport: ${request.transport}`);
  }
  const timeout = Math.min(Math.max(request.timeoutSecs ?? DEFAULT_PLUGIN_TIMEOUT_SECS, 1), MAX_PLUGIN_TIMEOUT_SECS);
  const report = await mcpCall({
    transport: request.transport,
    url: request.url,
    command: request.command,
    args: request.args,
    env: request.env,
    headers: request.headers,
    tool,
    arguments: request.arguments,
    timeoutSecs: timeout,
  });
  return { transport: report.transport, isError: report.isError, text: report.text, durationMs: report.durationMs };
}

/* ===== 官方注册表只读代理（mcp_registry.rs 移植） ===== */

const REGISTRY_ORIGIN = "https://registry.modelcontextprotocol.io";

export interface McpRemoteEndpoint {
  transport: string;
  url: string;
}

export interface McpPackageInfo {
  registry_type: string;
  identifier: string;
  version?: string | null;
  /** 声明的环境变量名清单（只透出名字，值由用户安装时自行提供）。 */
  env_names: string[];
}

export interface McpRegistryEntry {
  name: string;
  title?: string | null;
  description?: string | null;
  version?: string | null;
  repository_url?: string | null;
  status?: string | null;
  remotes: McpRemoteEndpoint[];
  packages: McpPackageInfo[];
}

type JsonRecord = Record<string, unknown>;

function strField(value: JsonRecord, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw !== "" ? raw : null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function normalizeRemote(value: unknown): McpRemoteEndpoint | null {
  const record = asRecord(value);
  if (!record) return null;
  const transport = strField(record, "type");
  const url = strField(record, "url");
  if (!transport || !url) return null;
  return { transport, url };
}

function normalizePackage(value: unknown): McpPackageInfo | null {
  const record = asRecord(value);
  if (!record) return null;
  const registryType = strField(record, "registryType");
  const identifier = strField(record, "identifier");
  if (!registryType || !identifier) return null;
  const envVars = Array.isArray(record.environmentVariables) ? record.environmentVariables : [];
  const envNames = envVars
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== null)
    .map((item) => strField(item, "name"))
    .filter((name): name is string => name !== null);
  return { registry_type: registryType, identifier, version: strField(record, "version"), env_names: envNames };
}

/** 归一化 /v0/servers 响应。跳过缺 name 或非 active 的条目。 */
export function normalizeRegistry(body: unknown): McpRegistryEntry[] {
  const root = asRecord(body);
  const items = root !== null && Array.isArray(root.servers) ? root.servers : [];
  const entries: McpRegistryEntry[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const server = record !== null ? asRecord(record.server) : null;
    if (!record || !server) continue;
    const name = strField(server, "name");
    if (!name) continue;
    const official = asRecord(asRecord(record._meta)?.["io.modelcontextprotocol.registry/official"]);
    const status = typeof official?.status === "string" ? official.status : null;
    // deleted 条目不进浏览列表。
    if (status === "deleted") continue;
    const repository = asRecord(server.repository);
    const repositoryUrl = repository !== null ? strField(repository, "url") : null;
    const remotes = (Array.isArray(server.remotes) ? server.remotes : [])
      .map(normalizeRemote)
      .filter((remote): remote is McpRemoteEndpoint => remote !== null);
    const packages = (Array.isArray(server.packages) ? server.packages : [])
      .map(normalizePackage)
      .filter((pkg): pkg is McpPackageInfo => pkg !== null);
    entries.push({
      name,
      title: strField(server, "title"),
      description: strField(server, "description"),
      version: strField(server, "version"),
      repository_url: repositoryUrl,
      status,
      remotes,
      packages,
    });
  }
  return entries;
}

/** 搜索官方注册表；search 为空时返回前 N 条。 */
export async function mcpSearch(search: string | null | undefined, limit: number | null | undefined): Promise<McpRegistryEntry[]> {
  const capped = Math.min(Math.max(limit ?? 20, 1), 100);
  const params = new URLSearchParams({ limit: String(capped) });
  const term = search?.trim();
  if (term) params.set("search", term);
  let response: Response;
  try {
    response = await fetch(`${REGISTRY_ORIGIN}/v0/servers?${params.toString()}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`registry request failed: ${(error as Error).message}`, { cause: error });
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch (error) {
    throw new Error(`invalid registry response: ${(error as Error).message}`, { cause: error });
  }
  return normalizeRegistry(body);
}
