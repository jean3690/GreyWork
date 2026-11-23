import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneRuntime } from "../src/control-plane.js";
import type { Db } from "../src/db.js";
import { EventBus } from "../src/events.js";
import { LlmStreamHost, chatComplete, fetchChatResponse, listModels } from "../src/llm.js";
import { LlmAgentHost } from "../src/llm-agent.js";
import { WorkspaceAccess } from "../src/workspace-access.js";
import { javaGatewayProvider } from "../src/model-gateway.js";

let directory: string;
let runtime: ControlPlaneRuntime;
let base: string;
let status = 200;
let hold = false;
const calls: { path: string; auth?: string; provider?: string; body: Record<string, unknown> }[] = [];
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  calls.push({
    path: request.url ?? "",
    auth: request.headers.authorization,
    provider: String(request.headers["x-grey-provider"] ?? ""),
    body,
  });
  if (request.url === "/v1/models") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }] }));
  } else if (status !== 200) {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ message: "登录态失效" }));
  } else if (hold) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n');
  } else if (body.tools && (body.messages as unknown[]).length < 3) {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"hello.txt"}' } }],
            },
          },
        ],
      }),
    );
  } else if (body.stream === false || body.tools) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "Java 网关完成" } }] }));
  } else {
    response.setHeader("content-type", "text/event-stream");
    response.end('data: {"choices":[{"delta":{"content":"你好 Java"}}]}\n\ndata: [DONE]\n\n');
  }
});

beforeEach(async () => {
  calls.length = 0;
  status = 200;
  hold = false;
  directory = mkdtempSync(path.join(process.env.OPENCODE_SESSION_ID ? "/tmp/opencode" : tmpdir(), "greywork-gateway-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv("GREYWORK_CONTROL_URL", base);
  vi.stubEnv("GREYWORK_CONTROL_TOKEN", "account-token");
  runtime = new ControlPlaneRuntime({ dataDir: directory, version: "test", db: {} as Db });
});
afterEach(async () => {
  runtime.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true });
});

describe("Java 模型网关", () => {
  it("连接只接受已知逻辑供应商，未登录不能拿到会话", () => {
    expect(javaGatewayProvider("greywork://java/openai")).toBe("openai");
    expect(javaGatewayProvider("https://third-party.test")).toBeNull();
    expect(() => javaGatewayProvider("greywork://java/../../evil")).toThrow();
    vi.stubEnv("GREYWORK_CONTROL_TOKEN", "");
    expect(() => runtime.openModelGateway()).toThrow("请先登录");
  });

  it("模型列表与聚合聊天复用当前账号，不使用前端填写的鉴权/地址", async () => {
    const session = runtime.openModelGateway();
    try {
      expect(
        await listModels({ baseUrl: "greywork://java/qwen", apiKeyEnv: "MISSING_KEY", headers: { Authorization: "evil" } }, session),
      ).toEqual(["a-model", "b-model"]);
      expect(
        await chatComplete({ baseUrl: "greywork://java/qwen", model: "a-model", messages: [{ role: "user", content: "你好" }] }, session),
      ).toBe("你好 Java");
      expect(calls.map((call) => call.path)).toEqual(["/v1/models", "/v1/chat/completions"]);
      expect(calls.every((call) => call.auth === "Bearer account-token" && call.provider === "qwen")).toBe(true);
    } finally {
      session.close();
    }
  });

  it("普通流式聊天产出原有事件，事件与请求正文不包含账号凭据", async () => {
    const bus = new EventBus();
    const emit = vi.spyOn(bus, "broadcast");
    const llm = new LlmStreamHost(bus, () => runtime.openModelGateway());
    await llm.start({
      baseUrl: "greywork://java/openai",
      model: "a-model",
      messages: [{ role: "user", content: "问候" }],
      clientToken: "turn",
    });
    await vi.waitFor(() => expect(emit.mock.calls.some(([, event]) => (event as { kind: string }).kind === "llm-done")).toBe(true));
    expect(JSON.stringify(emit.mock.calls)).toContain("你好 Java");
    expect(JSON.stringify(emit.mock.calls)).not.toContain("account-token");
    expect(JSON.stringify(calls[0].body)).not.toContain("account-token");
  });

  it("本机 Agent 经 Java 网关执行读工具并回填结果，授权边界不变", async () => {
    writeFileSync(path.join(directory, "hello.txt"), "workspace content");
    const bus = new EventBus();
    const emit = vi.spyOn(bus, "broadcast");
    const agent = new LlmAgentHost(bus, new WorkspaceAccess(directory, path.join(directory, "access.json")), {
      gatewayFactory: () => runtime.openModelGateway(),
    });
    agent.start({
      baseUrl: "greywork://java/openai",
      model: "a-model",
      messages: [{ role: "user", content: "读取 hello.txt" }],
      cwd: directory,
      permissionTier: "read-only",
    });
    await vi.waitFor(() => expect(emit.mock.calls.some(([, event]) => (event as { kind: string }).kind === "llm-done")).toBe(true));
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].body)).toContain("workspace content");
    expect(calls.every((call) => call.auth === "Bearer account-token")).toBe(true);
  });

  it("断开账号会取消在途响应，旧会话不能自动换号继续", async () => {
    hold = true;
    const session = runtime.openModelGateway();
    const response = await fetchChatResponse(
      { baseUrl: "greywork://java/openai" },
      { model: "a-model", stream: true },
      new AbortController().signal,
      session,
    );
    const reader = response.body!.getReader();
    await reader.read();
    const pending = reader.read();
    runtime.stop();
    await expect(pending).rejects.toThrow();
    vi.stubEnv("GREYWORK_CONTROL_TOKEN", "new-account-token");
    await expect(session.request("openai", {}, new AbortController().signal)).rejects.toThrow("账号连接已改变");
    session.close();
  });

  it("账号 401 不把旧对话回退到另一个直连供应商", async () => {
    status = 401;
    const bus = new EventBus();
    const emit = vi.spyOn(bus, "broadcast");
    const agent = new LlmAgentHost(bus, new WorkspaceAccess(directory, path.join(directory, "access.json")), {
      gatewayFactory: () => runtime.openModelGateway(),
    });
    agent.start({
      baseUrl: "greywork://java/openai",
      model: "a-model",
      messages: [{ role: "user", content: "问候" }],
      providers: [
        { baseUrl: "greywork://java/openai", model: "a-model" },
        { baseUrl: base, model: "direct-model" },
      ],
    });
    await vi.waitFor(() => expect(emit.mock.calls.some(([, event]) => (event as { kind: string }).kind === "llm-error")).toBe(true));
    expect(calls).toHaveLength(1);
    expect(emit.mock.calls.some(([, event]) => (event as { kind: string }).kind === "llm-provider-switch")).toBe(false);
  });
});
