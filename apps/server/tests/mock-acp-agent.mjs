#!/usr/bin/env node
// Mock ACP agent（stdio JSON-RPC 桩）：initialize / session/new / session/prompt
// / session/set_config_option / session/set_mode。initialize 声明支持 http+sse 两种 MCP 传输；
// session/new 返回一个 model 选择器与旧版 modes，并把收到的 mcpServers 原样放进 `_meta`
// 供集成测试断言；prompt 收到后流式发一条 agent_message_chunk，再以 end_turn 结束回合。
//
// prompt 文本命中触发词时改走权限链路（agent → 客户端的 session/request_permission）：
//   perm-allow → 只读工具 + 一个 allow_once 选项（宿主 read-only 档 AutoAllow）
//   perm-ask   → 只读工具 + 空 options（宿主 read-only 档落到 Ask，转发前端确认）
// 其余文本行为完全不变 —— 本文件与 apps/server/tests/acp_host.rs 及既有门禁用例共用。
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

/** 我们（agent）发往客户端的请求：登记 resolver 后 await 其响应（响应在 line 里按 id 派发）。 */
const pending = new Map();
let nextRequestId = 9000;
function request(method, params) {
  const id = nextRequestId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

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

/** 旧版会话模式（部分 agent 仍只用 session/set_mode，不走 config options）。 */
const sessionModes = {
  currentModeId: "build",
  availableModes: [
    { id: "build", name: "Build", description: "Implement and edit files" },
    { id: "plan", name: "Plan", description: "Read-only planning" },
  ],
};

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = message;

  // 客户端对我们发起请求（session/request_permission）的响应：无 method，带 id + result/error。
  if (method === undefined) {
    const resolver = pending.get(id);
    if (resolver) {
      pending.delete(id);
      resolver(message);
    }
    return;
  }

  if (method === "initialize") {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        // 声明会话生命周期能力：宿主恢复时优先 resume，换会话时可发 close。
        sessionCapabilities: { resume: {}, close: {} },
      },
    });
  } else if (method === "session/new") {
    reply(id, {
      sessionId: "sess-mock-001",
      configOptions,
      modes: sessionModes,
      _meta: { receivedMcpServers: params?.mcpServers ?? [] },
    });
  } else if (method === "session/resume" || method === "session/load") {
    // 两种恢复都回同一份配置；resume 不重放历史，load 在本桩里同样不重放
    // （真实 agent 会重放，前端回放抑制由 workbench 测试覆盖）。
    reply(id, { configOptions, modes: sessionModes });
  } else if (method === "session/close") {
    reply(id, {});
  } else if (method === "session/set_mode") {
    const { sessionId, modeId } = params ?? {};
    if (!sessionModes.availableModes.some((mode) => mode.id === modeId)) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown mode ${modeId}` } });
    } else {
      sessionModes.currentModeId = modeId;
      // 真实 agent 会广播 current_mode_update；宿主应转成 `mode` 事件。
      notify("session/update", {
        sessionId: sessionId ?? "sess-mock-001",
        update: { sessionUpdate: "current_mode_update", currentModeId: modeId },
      });
      reply(id, {});
    }
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

    // 触发词：改走权限链路，按宿主回传的 outcome 决定回合收尾。
    if (text.includes("perm-allow") || text.includes("perm-ask")) {
      const allow = text.includes("perm-allow");
      const response = await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: `tc-${id}`, title: "mock 权限请求", kind: "read" },
        // perm-allow 给一个 allow_once（read-only 档 AutoAllow）；perm-ask 给空 options（→ Ask）。
        options: allow ? [{ optionId: "allow-once", name: "允许一次", kind: "allow_once" }] : [],
      });
      const outcome = response?.result?.outcome;
      reply(id, { stopReason: outcome?.outcome === "selected" ? "end_turn" : "cancelled" });
      return;
    }

    // 等待可能的 $/cancel_request（300ms 窗口）再收尾；被取消则回 cancelled。
    const timer = setTimeout(() => {
      reply(id, { stopReason: "end_turn" });
    }, 300);
    cancelHandlers.push(() => {
      clearTimeout(timer);
      reply(id, { stopReason: "cancelled" });
    });
  } else if (method === "$/cancel_request" || method === "session/cancel") {
    // ACP 正路是 session/cancel（通知，无 id）；$/cancel_request 是 JSON-RPC 兜底。
    // 两者都触发同一批取消回调，重复到达时第二次自然为空操作。
    const handlers = cancelHandlers.splice(0);
    for (const handler of handlers) handler();
  } else if (id !== undefined) {
    reply(id, {});
  }
});

// $/cancel_request 是通知（无 id）：收到后触发当前 prompt 的取消回调。
const cancelHandlers = [];
