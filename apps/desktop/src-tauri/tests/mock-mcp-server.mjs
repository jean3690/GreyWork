//! Mock MCP server（stdio，换行分隔 JSON-RPC 2.0）：
//! initialize → 回协议版本与 serverInfo；notifications/initialized → 忽略；
//! tools/list → 回 echo / now 两个工具。模式照抄 mock-acp-agent.mjs。

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "mock-mcp", version: "1.0.0" },
          capabilities: {},
        },
      })}\n`,
    );
    return;
  }
  if (message.method === "tools/list") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            { name: "echo", description: "echo back a string" },
            { name: "now", description: "current time" },
          ],
        },
      })}\n`,
    );
  }
  // notifications（无 id）：无动作
});
