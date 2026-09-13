import { homeDir } from "@tauri-apps/api/path";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  client,
  type ClientContext,
  type ClientRequestContext,
  type McpServer,
  type NewSessionResponse,
  type PermissionOptionKind,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { createWebSocketStream, type WebSocketConstructor, type WebSocketLike } from "@agentclientprotocol/sdk/experimental/ws-client";
import type {
  AcpAvailableCommand,
  AcpConfigOptionChoice,
  AcpEventEnvelope,
  AcpPermissionOptionInfo,
  AcpPermissionRequestPayload,
  AcpPromptResult,
  AcpPromptUnit,
  AcpSandboxMode,
  AcpSessionConfigOption,
  AcpSessionInfo,
  AcpSessionOpened,
  AcpTransport,
  McpProbeReport,
  McpServerConfig,
  McpSkippedServer,
  McpToolInfo,
} from "./transports";
import type { PermissionTier } from "./permissions";
import { isTauriRuntime } from "./transports";
import { TauriIpcTransport } from "./tauri-transport";
export class RemoteAcpUnsupportedError extends Error {
  constructor(message = "remote ACP WebSocket endpoint is not configured") {
    super(message);
    this.name = "RemoteAcpUnsupportedError";
  }
}

/**
 * 把 MCP 声明转成 ACP schema 形状（`McpServer`）：http / sse 带 `type` 标签，
 * stdio 是 untagged 变体（无 type 字段），env 走 `{name,value}` 数组。
 * 桌面端由 Rust 宿主做同样的转换，这里是远程传输那一路。
 */
function toSchemaMcpServers(servers?: readonly McpServerConfig[]): McpServer[] {
  return (servers ?? []).map((server): McpServer => {
    if (server.transport === "stdio") {
      return {
        name: server.name,
        command: server.command ?? "",
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
      };
    }
    return {
      type: server.transport,
      name: server.name,
      url: server.url ?? "",
      headers: server.headers ?? [],
    };
  });
}

function optionKindLabel(kind: PermissionOptionKind): AcpPermissionOptionInfo["kind"] {
  switch (kind) {
    case "allow_always":
      return "allow_always";
    case "reject_once":
      return "reject_once";
    case "reject_always":
      return "reject_always";
    default:
      return "allow_once";
  }
}

/** 把 SDK 的 ConfigOption 归一成宿主侧 `AcpSessionConfigOption` 形状（前端消费）。 */
function toConfigOptions(options: SessionConfigOption[] | null | undefined): AcpSessionConfigOption[] {
  return (options ?? []).map((option) => option as AcpSessionConfigOption);
}

export interface WebSocketTransportOptions {
  url: string;
  protocols?: string | string[];
  /** Inject this in tests or runtimes that provide a WebSocket implementation. */
  socketFactory?: (url: string, protocols?: string | string[]) => WebSocket;
  requestTimeoutMs?: number;
}

/** 把 socketFactory 适配成 SDK createWebSocketStream 需要的构造器形状。 */
function webSocketCtorFromFactory(factory: (url: string, protocols?: string | string[]) => WebSocket): WebSocketConstructor {
  const Wrapper = function (this: unknown, url: string, protocols?: string | string[]): WebSocketLike {
    return factory(url, protocols);
  } as unknown as WebSocketConstructor;
  return Wrapper;
}

/** ACP client over a WebSocket connection。
 *
 * 协议层（JSON-RPC 帧、请求/响应关联、initialize / session/* 方法）交给官方
 * Zed SDK（`@agentclientprotocol/sdk`）：`client()` 建连接、绑 handler，
 * `createWebSocketStream` 管 WebSocket 收发。本类只保留网络骨架与宿主侧的自定义
 * 事件模型（AcpTransport 契约）：session-update / permission-request / prompt-done
 * 等 kind 事件，外部消费者无感。
 *
 * The endpoint is expected to expose an ACP agent (initialize/session/*).
 * `agentCmd` is retained in the common transport API but is not sent: unlike
 * the desktop transport, a remote endpoint already owns the agent process.
 */
export class WebSocketTransport implements AcpTransport {
  readonly id = "websocket" as const;
  readonly available: boolean;
  private readonly options?: WebSocketTransportOptions;
  private ctx: ClientContext | null = null;
  private connecting: Promise<ClientContext> | null = null;
  private releaseConnection: (() => void) | null = null;
  private nextTurnId = 1;
  private readonly listeners = new Set<(event: AcpEventEnvelope) => void>();
  private readonly inFlightPrompts = new Set<ReturnType<typeof setTimeout>>();
  private readonly permissionResolvers = new Map<number, (response: RequestPermissionResponse) => void>();
  private sessionId: string | null = null;

  constructor(options?: WebSocketTransportOptions) {
    this.options = options;
    this.available = Boolean(options?.url);
  }

  async startAgent(_agentCmd: string, _tier: PermissionTier): Promise<number> {
    const ctx = await this.ensureConnected();
    await ctx.request(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "GreyWork", version: "0.1.0" },
    });
    this.emit({ kind: "started", payload: { handle: 1 } });
    return 1;
  }

  /** 远程传输没有宿主强制面：档位由桌面宿主执行，这里明确报错而非假装降级成功。 */
  async setPermissionTier(_handle: number, _tier: PermissionTier): Promise<void> {
    throw new Error("ACP 远程传输不执行权限档位（档位由桌面宿主执行）");
  }
  async openSession(_handle: number, cwd: string, mcpServers?: readonly McpServerConfig[]): Promise<AcpSessionOpened> {
    const ctx = await this.ensureConnected();
    // 远程 agent 自己去连这些 MCP 服务器；这里只负责把声明送过去。
    // 能力过滤在桌面宿主里做，远程侧由对端自行拒绝并报错。
    const result = (await ctx.request(AGENT_METHODS.session_new, {
      cwd,
      mcpServers: toSchemaMcpServers(mcpServers),
    })) as NewSessionResponse;
    if (!result.sessionId) throw new Error("ACP session/new returned no sessionId");
    this.sessionId = result.sessionId;
    return {
      sessionId: result.sessionId,
      configOptions: toConfigOptions(result.configOptions),
      mcpServers: (mcpServers ?? []).map((server) => server.name),
    };
  }

  /** 远程传输不代管会话恢复（依赖桌面宿主的 session 持久化）：明确报错而非假装成功。 */
  async loadSession(_handle: number, _cwd: string, _sessionId: string, _mcpServers?: readonly McpServerConfig[]): Promise<never> {
    throw new RemoteAcpUnsupportedError("ACP 远程传输不代管会话恢复（恢复依赖桌面宿主的 session 持久化）");
  }

  /** 远程传输没有宿主进程面：探活需要本机发起 HTTP / spawn，明确报错而非假装成功。 */
  async probeMcp(_config: McpServerConfig, _timeoutSecs?: number): Promise<never> {
    throw new RemoteAcpUnsupportedError("MCP 探活需要桌面宿主（远程传输不代发探活请求）");
  }

  async setSessionConfig(_handle: number, configId: string, value: string | boolean): Promise<AcpSessionConfigOption[]> {
    const ctx = await this.ensureConnected();
    const result = await ctx.request(AGENT_METHODS.session_set_config_option, {
      sessionId: this.requireSession(),
      configId,
      ...(typeof value === "boolean" ? { type: "boolean", value } : { value }),
    });
    return toConfigOptions(result.configOptions);
  }

  async prompt(handle: number, text: string, units: readonly AcpPromptUnit[] = []): Promise<{ turnId: number }> {
    const ctx = await this.ensureConnected();
    // 与桌面传输一致：立即返回 turnId，回合结果经 prompt-done 事件送达。
    const turnId = this.nextTurnId++;
    const timer = setTimeout(() => {
      this.inFlightPrompts.delete(timer);
      this.emit({ kind: "prompt-done", payload: { handle, turnId, error: "ACP prompt timed out" } });
    }, this.options?.requestTimeoutMs ?? 30_000);
    this.inFlightPrompts.add(timer);
    ctx
      .request(AGENT_METHODS.session_prompt, {
        sessionId: this.requireSession(),
        prompt: [{ type: "text", text }, ...units],
      })
      .then((response) => {
        this.emit({ kind: "prompt-done", payload: { handle, turnId, response } });
      })
      .catch((error: unknown) => {
        this.emit({ kind: "prompt-done", payload: { handle, turnId, error: String(error) } });
      })
      .finally(() => {
        clearTimeout(timer);
        this.inFlightPrompts.delete(timer);
      });
    return { turnId };
  }

  async stop(_handle: number, _turnId?: number): Promise<void> {
    this.assertConfigured();
    if (this.sessionId && this.ctx) {
      try {
        await this.ctx.notify(AGENT_METHODS.session_cancel, { sessionId: this.sessionId });
      } catch {
        // 连接已断开时 session/cancel 只是 best-effort；下面统一 close。
      }
    }
    this.close();
  }

  async respondPermission(requestId: number, optionId: string | null): Promise<void> {
    this.assertConfigured();
    const resolve = this.permissionResolvers.get(requestId);
    if (!resolve) throw new Error(`unknown permission request ${requestId}`);
    this.permissionResolvers.delete(requestId);
    resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
  }

  async list(): Promise<AcpSessionInfo[]> {
    return this.sessionId ? [{ handle: 1, command: this.options?.url ?? "", hasSession: true }] : [];
  }

  async onEvent(listener: (event: AcpEventEnvelope) => void): Promise<() => void> {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async ensureConnected(): Promise<ClientContext> {
    this.assertConfigured();
    if (this.ctx) return this.ctx;
    if (!this.connecting) this.connecting = this.openConnection();
    const ctx = await this.connecting;
    if (!ctx) throw new RemoteAcpUnsupportedError("ACP WebSocket connection closed before it became ready");
    return ctx;
  }

  /** 建立 SDK 连接并保持存活，直到 stop()/close() 释放。 */
  private async openConnection(): Promise<ClientContext> {
    const options = this.options as WebSocketTransportOptions;
    let markReady!: () => void;
    let failConnection!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failConnection = reject;
    });

    const app = client({ name: "GreyWork" })
      .onNotification(CLIENT_METHODS.session_update, ({ params }: { params: SessionNotification }) => {
        this.emit({ kind: "session-update", payload: params });
      })
      .onRequest(CLIENT_METHODS.session_request_permission, (context: ClientRequestContext<RequestPermissionRequest>) =>
        this.handlePermission(Number(context.requestId), context.params),
      );

    const protocols = options.protocols ? (Array.isArray(options.protocols) ? options.protocols : [options.protocols]) : undefined;
    const stream = createWebSocketStream(options.url, {
      protocols,
      WebSocket: options.socketFactory ? webSocketCtorFromFactory(options.socketFactory) : undefined,
    });

    const hold = new Promise<void>((resolve) => {
      this.releaseConnection = resolve;
    });
    const connectionDone = app.connectWith(stream, async (ctx) => {
      this.ctx = ctx;
      markReady();
      await hold;
    });
    connectionDone.catch((error: unknown) => {
      // 连接在 ready 前失败：拒绝 ensureConnected；ready 后失败：正常闭环（connectWith 已 resolve）。
      failConnection(error);
      this.emit({ kind: "transport-error", payload: String(error) });
    });

    await ready;
    return this.ctx as ClientContext;
  }

  /** SDK 把 agent 的 session/request_permission 路由到这里：登记待决、转发事件、等应答。 */
  private handlePermission(requestId: number, params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      this.permissionResolvers.set(requestId, resolve);
      const payload: AcpPermissionRequestPayload = {
        requestId,
        auto: false,
        chosen: null,
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? null,
        kind: params.toolCall.kind ?? "other",
        options: (params.options ?? []).map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: optionKindLabel(option.kind),
        })),
      };
      this.emit({ kind: "permission-request", payload });
    });
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error("ACP session not created");
    return this.sessionId;
  }
  private assertConfigured(): void {
    if (!this.options?.url) throw new RemoteAcpUnsupportedError();
  }
  private emit(event: AcpEventEnvelope): void {
    for (const listener of this.listeners) listener(event);
  }
  private close(): void {
    this.releaseConnection?.();
    this.releaseConnection = null;
    this.ctx = null;
    const sessionId = this.sessionId;
    this.sessionId = null;
    for (const timer of this.inFlightPrompts) {
      clearTimeout(timer);
      this.inFlightPrompts.delete(timer);
    }
    for (const resolve of this.permissionResolvers.values()) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionResolvers.clear();
    if (sessionId) this.emit({ kind: "stopped", payload: { handle: 1 } });
  }
}

/** 统一 client 面：按运行环境选择传输（desktop→Tauri IPC；web→可配置远程 WebSocket）。 */
export interface AcpClient {
  readonly transportId: "tauri-ipc" | "websocket";
  isAvailable(): boolean;
  /** sandbox 非 off 时宿主以 OS 沙盒包裹 agent；workspace 为沙盒可写锚定目录。 */
  startAgent(agentCmd: string, tier: PermissionTier, sandbox?: AcpSandboxMode, workspace?: string | null): Promise<number>;
  /** 建会话；`mcpServers` 随 session/new 声明给 agent，由 agent 连接并合并工具面。 */
  openSession(handle: number, cwd: string, mcpServers?: readonly McpServerConfig[]): Promise<AcpSessionOpened>;
  /** 恢复已存在会话（session/load）；agent 不支持时由调用方回落 openSession。 */
  loadSession(handle: number, cwd: string, sessionId: string, mcpServers?: readonly McpServerConfig[]): Promise<AcpSessionOpened>;
  /** 改写在途会话的权限档位（临时降级/回升）；桌面宿主立即生效。 */
  setPermissionTier(handle: number, tier: PermissionTier): Promise<void>;
  setSessionConfig(handle: number, configId: string, value: string | boolean): Promise<AcpSessionConfigOption[]>;
  prompt(handle: number, text: string, units?: readonly AcpPromptUnit[]): Promise<{ turnId: number }>;
  stop(handle: number, turnId?: number): Promise<void>;
  respondPermission(requestId: number, optionId: string | null): Promise<void>;
  list(): Promise<AcpSessionInfo[]>;
  onEvent(listener: (event: AcpEventEnvelope) => void): Promise<() => void>;
  /** 探活一台 MCP 服务器（设置页「测试连接」）；远程传输不支持，会抛 RemoteAcpUnsupportedError。 */
  probeMcp(config: McpServerConfig, timeoutSecs?: number): Promise<McpProbeReport>;
}

/** 按运行环境自动选择传输；测试/桌面可显式注入。 */
export function createAcpClient(transport: AcpTransport = defaultTransport()): AcpClient {
  return {
    transportId: transport.id,
    isAvailable: () => transport.available ?? transport.id === "tauri-ipc",
    startAgent: (cmd, tier, sandbox, workspace) => transport.startAgent(cmd, tier, sandbox, workspace),
    openSession: (handle, cwd, mcpServers) => transport.openSession(handle, cwd, mcpServers),
    loadSession: (handle, cwd, sessionId, mcpServers) => transport.loadSession(handle, cwd, sessionId, mcpServers),
    setSessionConfig: (handle, configId, value) => transport.setSessionConfig(handle, configId, value),
    setPermissionTier: (handle, tier) => transport.setPermissionTier(handle, tier),
    prompt: (handle, text, units) => transport.prompt(handle, text, units),
    stop: (handle, turnId) => transport.stop(handle, turnId),
    respondPermission: (requestId, optionId) => transport.respondPermission(requestId, optionId),
    list: () => transport.list(),
    onEvent: (listener) => transport.onEvent(listener),
    probeMcp: (config, timeoutSecs) => transport.probeMcp(config, timeoutSecs),
  };
}

function defaultTransport(): AcpTransport {
  return isTauriRuntime() ? new TauriIpcTransport() : new WebSocketTransport();
}

export { isTauriRuntime };

/** 桌面端默认工作区目录（用户主目录）；Web 环境返回 null。 */
export async function desktopHomeDir(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return homeDir();
}

export type {
  AcpAvailableCommand,
  AcpEventEnvelope,
  AcpConfigOptionChoice,
  AcpPermissionOptionInfo,
  AcpPermissionRequestPayload,
  AcpPromptResult,
  AcpPromptUnit,
  AcpSandboxMode,
  AcpSessionConfigOption,
  AcpSessionInfo,
  AcpSessionOpened,
  AcpTransport,
  McpProbeReport,
  McpServerConfig,
  McpSkippedServer,
  McpToolInfo,
};
