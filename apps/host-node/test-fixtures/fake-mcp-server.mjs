#!/usr/bin/env node
/**
 * 测试用的最小 stdio MCP server：initialize / tools/list / tools/call。
 *
 * 行分隔 JSON-RPC（与 host 的 StdioSession 一致，不是 LSP 的 Content-Length 帧）。
 * 只提供一个 echo 工具，用来验证「探测 → 注册 → 调用」整条链路。
 */
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message);
  }
});

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "原样回显输入",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: "要回显的文本" } },
              required: ["text"],
            },
          },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const params = message.params ?? {};
    if (params.name !== "echo") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown tool" } });
      return;
    }
    const text = String(params.arguments?.text ?? "");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "echo: " + text }], isError: false },
    });
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
}
