// Phase 2 验证：AcpClient 以 fake transport 跑通 start→session→prompt→stream→stop。
import { describe, expect, it } from "vitest";
import type { PermissionTier } from "../../src/permissions";
import {
  createAcpClient,
  RemoteAcpUnsupportedError,
  WebSocketTransport,
  type AcpEventEnvelope,
  type AcpTransport,
  type WebSocketTransportOptions,
} from "../../src/client";

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
    async setPermissionTier(handle, tier) {
      events.push({ kind: "tier-changed", payload: { handle, tier } });
    },
    async openSession(_handle, _cwd, mcpServers) {
      events.push({ kind: "session-opened", payload: { mcpServers } });
      return {
        sessionId: "sess-fake",
        configOptions: [],
        mcpServers: (mcpServers ?? []).map((server) => server.name),
      };
    },
    async probeMcp(config) {
      return {
        transport: config.transport,
        serverName: "fake-server",
        serverVersion: "1.0.0",
        tools: [{ name: "echo", description: "echo back" }],
        durationMs: 1,
      };
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
      // 新契约：立即返回 turnId；回合结果经 prompt-done 事件送达。
      events.push({ kind: "prompt-done", payload: { handle: _handle, turnId: 7, response: { stopReason: "end_turn" } } });
      for (const listener of listeners) listener(events[events.length - 1]!);
      return { turnId: 7 };
    },
    async stop(_handle, turnId) {
      events.push({ kind: "stopped", payload: { handle: _handle, turnId } });
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

    const handle = await client.startAgent("node mock.mjs", "read-only");
    expect(handle).toBe(1);
    const opened = await client.openSession(handle, "/tmp", [{ name: "deepwiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" }]);
    expect(opened.sessionId).toBe("sess-fake");
    // MCP 声明必须原样传到传输层，并回报实际声明了哪些
    expect(transport.events.at(-1)).toMatchObject({
      kind: "session-opened",
      payload: { mcpServers: [{ name: "deepwiki", transport: "http" }] },
    });
    expect(opened.mcpServers).toEqual(["deepwiki"]);
    const probe = await client.probeMcp({ name: "deepwiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" });
    expect(probe.tools.map((tool) => tool.name)).toEqual(["echo"]);
    const options = await client.setSessionConfig(handle, "model", "mock-slow");
    expect(options[0]?.id).toBe("model");
    expect(options[0]?.currentValue).toBe("mock-slow");
    const result = await client.prompt(handle, "hello");
    expect(result.turnId).toBe(7);
    await client.stop(handle, 7);

    expect(received.map((event) => event.kind)).toEqual(["session-update", "prompt-done"]);
    unsubscribe();
  });
});

describe("WebSocketTransport（web 远程骨架）", () => {
  it("所有操作以 RemoteAcpUnsupportedError 拒绝，list 返回空", async () => {
    const transport = new WebSocketTransport();
    const tier: PermissionTier = "read-only";
    await expect(transport.startAgent("node x.mjs", tier)).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    await expect(transport.openSession(1, "/tmp")).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    await expect(transport.setSessionConfig(1, "model", "x")).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    await expect(transport.stop(1)).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    await expect(transport.respondPermission(1, null)).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    await expect(transport.list()).resolves.toEqual([]);
    await expect(transport.probeMcp({ name: "x", transport: "http", url: "https://example.com/mcp" })).rejects.toBeInstanceOf(
      RemoteAcpUnsupportedError,
    );
  });

  it("web 环境下默认 client 不可用且 chat 拒绝", async () => {
    // node/vitest 无 __TAURI_INTERNALS__：isTauriRuntime()=false → websocket 骨架
    const client = createAcpClient();
    if (client.transportId !== "websocket") return;
    expect(client.isAvailable()).toBe(false);
    await expect(client.startAgent("node x.mjs", "full")).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
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

  toolCallUpdate(update: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "remote-session", update },
      }),
    });
  }

  toolCallContentChunk(update: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "remote-session", update: { sessionUpdate: "tool_call_content_chunk", ...update } },
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
    expect(await transport.startAgent("ignored", "workspace")).toBe(1);
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

  it("转发真实 ACP v2 tool_call_update 顶层负载（真实数据源）", async () => {
    FakeWebSocket.instances = [];
    const options: WebSocketTransportOptions = { url: "ws://acp.test", socketFactory: () => new FakeWebSocket() as unknown as WebSocket };
    const transport = new WebSocketTransport(options);
    const events: AcpEventEnvelope[] = [];
    await transport.onEvent((event) => events.push(event));
    await transport.startAgent("ignored", "workspace");
    await transport.openSession(1, "/tmp");
    const socket = FakeWebSocket.instances[0]!;
    socket.toolCallUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_001",
      title: "Reading config",
      kind: "read",
      status: "pending",
    });
    socket.toolCallUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_001", status: "in_progress" });
    socket.toolCallContentChunk({ toolCallId: "call_001", content: { type: "terminal", terminalId: "term_1" } });
    socket.toolCallUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_001", status: "completed" });

    const toolEvents = events.filter((e) => e.kind === "session-update");
    const updates = toolEvents.map((e) => {
      const payload = e.payload as { sessionId?: string; update?: { sessionUpdate?: string; status?: string } };
      expect(payload.sessionId).toBe("remote-session");
      return payload.update;
    });
    expect(updates.map((u) => u?.sessionUpdate)).toEqual([
      "tool_call_update",
      "tool_call_update",
      "tool_call_content_chunk",
      "tool_call_update",
    ]);
    expect(updates.filter((u) => u?.sessionUpdate === "tool_call_update").map((u) => u?.status)).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
    expect(updates.some((u) => u?.sessionUpdate === "tool_call_content_chunk")).toBe(true);
  });

  it("sends ACP cancel and rejects an unconfigured remote transport", async () => {
    const transport = new WebSocketTransport();
    await expect(transport.prompt(1, "hello")).rejects.toBeInstanceOf(RemoteAcpUnsupportedError);
    const configured = new WebSocketTransport({ url: "ws://acp.test", socketFactory: () => new FakeWebSocket() as unknown as WebSocket });
    await configured.startAgent("", "full");
    await configured.openSession(1, "/tmp");
    const socket = FakeWebSocket.instances.at(-1)!;
    await configured.stop(1);
    expect(JSON.parse(socket.sent.at(-1)!).method).toBe("session/cancel");
  });
});
