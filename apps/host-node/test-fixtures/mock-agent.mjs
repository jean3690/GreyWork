#!/usr/bin/env node
// 测试用 mock ACP agent：行分隔 JSON-RPC，覆盖 initialize / session/new / session/prompt /
// session/request_permission / session/cancel。仅用于测试与本地联调。
let buffer = "";
const pending = new Map();

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const sendRequest = (method, params, id) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line === "") continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && message.method === undefined) {
      const resolve = pending.get(message.id);
      if (resolve) resolve(message.result);
      continue;
    }
    if (message.method === "initialize") {
      reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, promptCapabilities: { image: true } });
      continue;
    }
    if (message.method === "session/new") {
      reply(message.id, { sessionId: "sess-1", modes: { availableModes: [{ id: "build", name: "Build" }] } });
      continue;
    }
    if (message.method === "session/prompt") {
      const text = message.params.prompt.map((block) => block.text ?? "").join("");
      notify("session/update", {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo back: " + text } },
      });
      void sendRequest(
        "session/request_permission",
        {
          sessionId: "sess-1",
          toolCall: { toolCallId: "tc-1", fields: { title: "run mock", kind: "execute" } },
          options: [{ id: "allow", name: "Allow", kind: "allow_once" }],
        },
        999,
      ).then(() => {
        reply(message.id, { stopReason: "end_turn" });
      });
      continue;
    }
    if (message.method === "session/cancel") {
      continue;
    }
    reply(message.id, {});
  }
});
