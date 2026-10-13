#!/usr/bin/env node
// Mock ACP agent（stdio JSON-RPC 桩）：initialize / session/new / session/prompt
// / session/set_config_option。initialize 声明支持 http+sse 两种 MCP 传输；
// session/new 返回一个 model 选择器，并把收到的 mcpServers 原样放进 `_meta`
// 供集成测试断言；prompt 收到后流式发两条 agent_message_chunk，再以 end_turn 结束回合。
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "mock/fast",
    options: [
      { value: "mock/fast", name: "Mock Fast" },
      { value: "mock/slow", name: "Mock Slow" },
    ],
  },
];

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
    });
  } else if (method === "session/new") {
    reply(id, {
      sessionId: "sess-mock-001",
      configOptions,
      _meta: { receivedMcpServers: params?.mcpServers ?? [] },
    });
  } else if (method === "session/set_config_option") {
    const { configId, value } = params ?? {};
    const option = configOptions.find((entry) => entry.id === configId);
    if (option) {
      option.currentValue = value;
      reply(id, { configOptions });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown config option ${configId}` } });
    }
  } else if (method === "session/prompt") {
    const sessionId = params?.sessionId ?? "sess-mock-001";
    const text = params?.prompt?.[0]?.text ?? params?.prompt ?? "";
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } },
    });
    // 等待可能的 $/cancel_request（300ms 窗口）再收尾；被取消则回 cancelled。
    const timer = setTimeout(() => {
      reply(id, { stopReason: "end_turn" });
    }, 300);
    cancelHandlers.push(() => {
      clearTimeout(timer);
      reply(id, { stopReason: "cancelled" });
    });
  } else if (method === "$/cancel_request") {
    const handlers = cancelHandlers.splice(0);
    for (const handler of handlers) handler();
  } else if (id !== undefined) {
    reply(id, {});
  }
});

// $/cancel_request 是通知（无 id）：收到后触发当前 prompt 的取消回调。
const cancelHandlers = [];
