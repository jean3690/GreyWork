#!/usr/bin/env node
// 测试用 mock ACP agent：行分隔 JSON-RPC，覆盖 initialize / session/new / session/prompt /
// session/request_permission / session/cancel。仅用于测试与本地联调。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

let buffer = "";
/** 会话 cwd（由 session/new 下发）；产物按它落盘，不依赖 agent 进程 cwd。 */
let sessionCwd = process.cwd();
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
      // MCP 能力面：默认声明支持 http / sse；MOCK_MCP_HTTP=0 时模拟只支持 stdio 的 agent。
      const mcpHttp = process.env.MOCK_MCP_HTTP !== "0";
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: mcpHttp, sse: mcpHttp } },
        promptCapabilities: { image: true },
      });
      continue;
    }
    if (message.method === "session/new") {
      if (typeof message.params.cwd === "string") sessionCwd = message.params.cwd;
      // 回带收到的 mcpServers：宿主 → agent 的透传由 tests/server.test.ts 断言。
      reply(message.id, {
        sessionId: "sess-1",
        modes: { availableModes: [{ id: "build", name: "Build" }] },
        mcpServersEcho: message.params.mcpServers ?? [],
      });
      continue;
    }
    if (message.method === "session/prompt") {
      const text = message.params.prompt.map((block) => block.text ?? "").join("");
      // 模拟 agent 落盘交付物：按 session/new 下发的 cwd 写，供 prompt-done 的
      // files 产物扫描断言（见 tests/server.test.ts）。不依赖 agent 进程 cwd。
      const reportPath = path.join(sessionCwd, "reports", "report.md");
      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, "# report\n");
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
