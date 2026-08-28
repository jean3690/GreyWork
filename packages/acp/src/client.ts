import { homeDir } from "@tauri-apps/api/path";
import type {
  AcpConfigOptionChoice,
  AcpEventEnvelope,
  AcpPermissionOptionInfo,
  AcpPermissionRequestPayload,
  AcpPromptResult,
  AcpSessionConfigOption,
  AcpSessionInfo,
  AcpSessionOpened,
  AcpTransport,
} from "./transports";
import type { PermissionTier } from "./permissions";
import { isTauriRuntime } from "./transports";
import { TauriIpcTransport } from "./tauri-transport";
export class RemoteAcpUnsupportedError extends Error {
  constructor() {
    super("remote ACP WebSocket endpoint is not configured");
    this.name = "RemoteAcpUnsupportedError";
  }
}

export interface WebSocketTransportOptions {
  url: string;
  protocols?: string | string[];
  /** Inject this in tests or runtimes that provide a WebSocket implementation. */
  socketFactory?: (url: string, protocols?: string | string[]) => WebSocket;
  requestTimeoutMs?: number;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** ACP JSON-RPC client over a WebSocket connection.
 *
 * The endpoint is expected to expose an ACP agent (initialize/session/*).
 * `agentCmd` is retained in the common transport API but is not sent: unlike
 * the desktop transport, a remote endpoint already owns the agent process.
 */
export class WebSocketTransport implements AcpTransport {
  readonly id = "websocket" as const;
  readonly available: boolean;
  private readonly options?: WebSocketTransportOptions;
  private socket: WebSocket | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(event: AcpEventEnvelope) => void>();
  private readonly permissionRequests = new Set<number>();
  private sessionId: string | null = null;

  constructor(options?: WebSocketTransportOptions) {
    this.options = options;
    this.available = Boolean(options?.url);
  }

  async startAgent(_agentCmd: string, _tier: PermissionTier): Promise<number> {
    await this.ensureConnected();
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "GreyWork", version: "0.1.0" },
    });
    this.emit({ kind: "started", payload: { handle: 1 } });
    return 1;
  }

  async openSession(_handle: number, cwd: string): Promise<AcpSessionOpened> {
    this.assertConfigured();
    const result = (await this.request("session/new", { cwd, mcpServers: [] })) as {
      sessionId?: string;
      configOptions?: AcpSessionConfigOption[];
    };
    if (!result.sessionId) throw new Error("ACP session/new returned no sessionId");
    this.sessionId = result.sessionId;
    return { sessionId: result.sessionId, configOptions: result.configOptions ?? [] };
  }

  async setSessionConfig(_handle: number, configId: string, value: string | boolean): Promise<AcpSessionConfigOption[]> {
    this.assertConfigured();
    const result = (await this.request("session/set_config_option", {
      sessionId: this.requireSession(),
      configId,
      value,
    })) as { configOptions?: AcpSessionConfigOption[] };
    return result.configOptions ?? [];
  }

  async prompt(_handle: number, text: string): Promise<AcpPromptResult> {
    this.assertConfigured();
    return (await this.request("session/prompt", {
      sessionId: this.requireSession(),
      prompt: [{ type: "text", text }],
    })) as AcpPromptResult;
  }

  async stop(_handle: number): Promise<void> {
    this.assertConfigured();
    if (this.socket?.readyState === WebSocket.OPEN && this.sessionId) {
      await this.notify("session/cancel", { sessionId: this.sessionId });
    }
    this.close(new Error("ACP transport stopped"));
  }

  async respondPermission(requestId: number, optionId: string | null): Promise<void> {
    this.assertConfigured();
    if (!this.permissionRequests.delete(requestId)) throw new Error(`unknown permission request ${requestId}`);
    this.send({
      jsonrpc: "2.0",
      id: requestId,
      result: optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } },
    });
  }

  async list(): Promise<AcpSessionInfo[]> {
    return this.sessionId ? [{ handle: 1, command: this.options?.url ?? "", hasSession: true }] : [];
  }

  async onEvent(listener: (event: AcpEventEnvelope) => void): Promise<() => void> {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async ensureConnected(): Promise<void> {
    this.assertConfigured();
    const options = this.options as WebSocketTransportOptions;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const Factory = options.socketFactory ?? ((url: string, protocols?: string | string[]) => new WebSocket(url, protocols));
    const socket = Factory(options.url, options.protocols);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("ACP WebSocket connection failed"));
      socket.onclose = () => this.close(new Error("ACP WebSocket connection closed"));
      socket.onmessage = (event) => {
        void this.receive(event.data);
      };
    });
  }

  private async receive(data: unknown): Promise<void> {
    try {
      const raw =
        typeof data === "string" ? data : data instanceof Blob ? await data.text() : new TextDecoder().decode(data as ArrayBuffer);
      const message = JSON.parse(raw) as JsonRpcMessage;
      if (message.method) {
        if (message.id === undefined) {
          const kind = message.method === "session/update" ? "session-update" : message.method;
          this.emit({ kind, payload: message.params ?? null });
          return;
        }
        if (message.method === "session/request_permission") {
          this.permissionRequests.add(message.id);
          this.emit({
            kind: "permission-request",
            payload: { requestId: message.id, auto: false, chosen: null, ...(message.params ?? {}) },
          });
          return;
        }
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported client method: ${message.method}` } });
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "ACP request failed"));
      else pending.resolve(message.result);
    } catch (error) {
      this.emit({ kind: "transport-error", payload: String(error) });
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, this.options?.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("ACP WebSocket is not connected");
    this.socket.send(JSON.stringify(message));
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
  private close(error: Error): void {
    const socket = this.socket;
    this.socket = null;
    this.sessionId = null;
    this.permissionRequests.clear();
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

/** 统一 client 面：按运行环境选择传输（desktop→Tauri IPC；web→可配置远程 WebSocket）。 */
export interface AcpClient {
  readonly transportId: "tauri-ipc" | "websocket";
  isAvailable(): boolean;
  startAgent(agentCmd: string, tier: PermissionTier): Promise<number>;
  openSession(handle: number, cwd: string): Promise<AcpSessionOpened>;
  setSessionConfig(handle: number, configId: string, value: string | boolean): Promise<AcpSessionConfigOption[]>;
  prompt(handle: number, text: string): Promise<AcpPromptResult>;
  stop(handle: number): Promise<void>;
  respondPermission(requestId: number, optionId: string | null): Promise<void>;
  list(): Promise<AcpSessionInfo[]>;
  onEvent(listener: (event: AcpEventEnvelope) => void): Promise<() => void>;
}

/** 按运行环境自动选择传输；测试/桌面可显式注入。 */
export function createAcpClient(transport: AcpTransport = defaultTransport()): AcpClient {
  return {
    transportId: transport.id,
    isAvailable: () => transport.available ?? transport.id === "tauri-ipc",
    startAgent: (cmd, tier) => transport.startAgent(cmd, tier),
    openSession: (handle, cwd) => transport.openSession(handle, cwd),
    setSessionConfig: (handle, configId, value) => transport.setSessionConfig(handle, configId, value),
    prompt: (handle, text) => transport.prompt(handle, text),
    stop: (handle) => transport.stop(handle),
    respondPermission: (requestId, optionId) => transport.respondPermission(requestId, optionId),
    list: () => transport.list(),
    onEvent: (listener) => transport.onEvent(listener),
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
  AcpEventEnvelope,
  AcpConfigOptionChoice,
  AcpPermissionOptionInfo,
  AcpPermissionRequestPayload,
  AcpPromptResult,
  AcpSessionConfigOption,
  AcpSessionInfo,
  AcpSessionOpened,
  AcpTransport,
};
