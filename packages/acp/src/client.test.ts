// Phase 2 验证：AcpClient 以 fake transport 跑通 start→session→prompt→stream→stop。
// （AcpAgentAdapter 组合测试已迁至 @greywork/integrations，见 acp-adapter.test.ts。）
import { describe, expect, it } from "vitest";
import type { PermissionTier } from "./permissions";
import {
  createAcpClient,
  RemoteAcpUnsupportedError,
  WebSocketTransport,
  type AcpEventEnvelope,
  type AcpTransport,
  type WebSocketTransportOptions,
} from "./client";

function fakeTransport(): AcpTransport & { events: AcpEventEnvelope[] } {
  const events: AcpEventEnvelope[] = [];
  const listeners = new Set<(event: AcpEventEnvelope) => void>();
  return {
    id: "tauri-ipc",
    events,
    async startAgent(_cmd: string, _tier: PermissionTier) {
      events.push({ kind: "started", payload: { handle: 1 } });
      return 1;
    },
    async openSession() {
      return { sessionId: "sess-fake", configOptions: [] };
    },
    async setSessionConfig(_handle, configId, value) {
      return [
        {
          id: configId,
          name: "Model",
          type: "select",
          currentValue: value,
          options: [{ value: String(value), name: String(value) }],
        },
      ];
    },
    async prompt(_handle, text) {
      events.push({ kind: "session-update", payload: { text } });
      for (const listener of listeners) listener(events[events.length - 1]!);
      return { stopReason: "end_turn" };
    },
    async stop() {
      events.push({ kind: "stopped", payload: {} });
    },
    async respondPermission(requestId, optionId) {
      events.push({ kind: "permission-resolved", payload: { requestId, optionId } });
    },
    async list() {
      return [];
    },
    async onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe("AcpClient over fake transport", () => {
  it("runs start → session → setConfig → prompt with streamed events and stop", async () => {
    const transport = fakeTransport();
    const client = createAcpClient(transport);

    const received: AcpEventEnvelope[] = [];
    const unsubscribe = await client.onEvent((event) => received.push(event));

    const handle = await client.startAgent("node mock.mjs", "cautious");
    expect(handle).toBe(1);
    const opened = await client.openSession(handle, "/tmp");
    expect(opened.sessionId).toBe("sess-fake");
    const options = await client.setSessionConfig(handle, "model", "mock-slow");
    expect(options[0]?.id).toBe("model");
    expect(options[0]?.currentValue).toBe("mock-slow");
    const result = await client.prompt(handle, "hello");
    expect(result.stopReason).toBe("end_turn");
    await client.stop(handle);

    expect(received.map((event) => event.kind)).toEqual(["session-update"]);
    unsubscribe();
  });
});

describe("WebSocketTransport（web 远程骨架）", () => {
  it("所有操作以 RemoteAcpUnsupportedError 拒绝，list 返回空", async () => {
    const transport = new WebSocketTransport();
    const tier: PermissionTier = "cautious";
    await expect(transport.startAgent("node x.mjs", tier)).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    await expect(transport.openSession(1, "/tmp")).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    await expect(transport.setSessionConfig(1, "model", "x")).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    await expect(transport.stop(1)).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    await expect(transport.respondPermission(1, null)).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    await expect(transport.list()).resolves.toEqual([]);
  });

  it("web 环境下默认 client 不可用且 chat 拒绝", async () => {
    // node/vitest 无 __TAURI_INTERNALS__：isTauriRuntime()=false → websocket 骨架
    const client = createAcpClient();
    if (client.transportId !== "websocket") return;
    expect(client.isAvailable()).toBe(false);
    await expect(client.startAgent("node x.mjs", "auto")).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(raw: string): void {
    this.sent.push(raw);
    const request = JSON.parse(raw) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (request.id === undefined) return;
    const result =
      request.method === "initialize"
        ? { protocolVersion: 1 }
        : request.method === "session/new"
          ? { sessionId: "remote-session", configOptions: [] }
          : request.method === "session/set_config_option"
            ? { configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "fast" }] }
            : request.method === "session/prompt"
              ? { stopReason: "end_turn" }
              : {};
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) }));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  permissionRequest(id: number): void {
    this.onmessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "session/request_permission",
        params: { toolCallId: "call-1", kind: "read", options: [] },
      }),
    });
  }

  update(text: string): void {
    this.onmessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } },
      }),
    });
  }
}

describe("WebSocketTransport ACP JSON-RPC", () => {
  it("negotiates, opens a session, streams notifications, and responds to permissions", async () => {
    FakeWebSocket.instances = [];
    const options: WebSocketTransportOptions = { url: "ws://acp.test", socketFactory: () => new FakeWebSocket() as unknown as WebSocket };
    const transport = new WebSocketTransport(options);
    const events: AcpEventEnvelope[] = [];
    await transport.onEvent((event) => events.push(event));
    expect(await transport.startAgent("ignored", "daily")).toBe(1);
    const socket = FakeWebSocket.instances[0]!;
    expect(JSON.parse(socket.sent[0]!).method).toBe("initialize");
    expect((await transport.openSession(1, "/tmp")).sessionId).toBe("remote-session");
    expect((await transport.setSessionConfig(1, "model", "fast"))[0]?.currentValue).toBe("fast");
    socket.update("hello");
    socket.permissionRequest(99);
    await transport.respondPermission(99, "allow");
    expect(JSON.parse(socket.sent.at(-1)!).result.outcome.optionId).toBe("allow");
    expect(events.map((event) => event.kind)).toEqual(["started", "session-update", "permission-request"]);
  });

  it("sends ACP cancel and rejects an unconfigured remote transport", async () => {
    const transport = new WebSocketTransport();
    await expect(transport.prompt(1, "hello")).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    const configured = new WebSocketTransport({ url: "ws://acp.test", socketFactory: () => new FakeWebSocket() as unknown as WebSocket });
    await configured.startAgent("", "auto");
    await configured.openSession(1, "/tmp");
    const socket = FakeWebSocket.instances.at(-1)!;
    await configured.stop(1);
    expect(JSON.parse(socket.sent.at(-1)!).method).toBe("session/cancel");
  });
});
