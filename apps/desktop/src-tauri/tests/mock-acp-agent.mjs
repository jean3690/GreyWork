#!/usr/bin/env node
// Mock ACP agent（stdio JSON-RPC 桩）：initialize / session/new / session/prompt
// / session/set_config_option。session/new 返回一个 model 选择器；
// prompt 收到后流式发两条 agent_message_chunk，再以 end_turn 结束回合。
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
    reply(id, { protocolVersion: 1, agentCapabilities: {} });
  } else if (method === "session/new") {
    reply(id, { sessionId: "sess-mock-001", configOptions });
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
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " [mock done]" } },
    });
    reply(id, { stopReason: "end_turn" });
  } else if (id !== undefined) {
    reply(id, {});
  }
});
