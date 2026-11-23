#!/usr/bin/env node
/** 零依赖、只读的 stdio MCP 测试服务器；只处理 JSON-RPC，不在 stdout 打日志。 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const { name, version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const numbers = {
  type: "object",
  properties: { a: { type: "number" }, b: { type: "number" } },
  required: ["a", "b"],
  additionalProperties: false,
};
const tools =
  name === "greywork-demo-echo"
    ? [
        {
          name: "demo_echo",
          description: "原样返回输入文字，用于验证 Java 后端下载的 MCP 已成功运行。",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string", maxLength: 4096 } },
            required: ["text"],
            additionalProperties: false,
          },
          annotations,
        },
      ]
    : [
        { name: "demo_add", description: "计算两个有限数字的和。", inputSchema: numbers, annotations },
        { name: "demo_multiply", description: "计算两个有限数字的积。", inputSchema: numbers, annotations },
      ];

function call(params) {
  const tool = tools.find((item) => item.name === params?.name);
  if (!tool) return { content: [{ type: "text", text: "未知测试工具" }], isError: true };
  const args = params.arguments ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) return failure("参数必须是对象");
  if (tool.name === "demo_echo") {
    if (typeof args.text !== "string" || args.text.length > 4096 || Object.keys(args).some((key) => key !== "text")) {
      return failure("text 必须是最多 4096 字符的字符串");
    }
    return { content: [{ type: "text", text: args.text }] };
  }
  if (!Number.isFinite(args.a) || !Number.isFinite(args.b) || Object.keys(args).some((key) => key !== "a" && key !== "b")) {
    return failure("a 和 b 必须是有限数字");
  }
  const result = tool.name === "demo_add" ? args.a + args.b : args.a * args.b;
  return Number.isFinite(result) ? { content: [{ type: "text", text: String(result) }] } : failure("计算结果溢出");
}

function failure(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function respond(id, body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line) > 64 * 1024) return respond(null, { error: { code: -32600, message: "Request too large" } });
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return respond(null, { error: { code: -32700, message: "Parse error" } });
  }
  if (!request || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return respond(null, { error: { code: -32600, message: "Invalid request" } });
  }
  // notifications/initialized 与其它通知均不回包。
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize": {
      const supported = ["2025-06-18", "2025-03-26", "2024-11-05"];
      const requested = request.params?.protocolVersion;
      return respond(request.id, {
        result: {
          protocolVersion: supported.includes(requested) ? requested : supported[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        },
      });
    }
    case "ping":
      return respond(request.id, { result: {} });
    case "tools/list":
      return respond(request.id, { result: { tools } });
    case "tools/call":
      return respond(request.id, { result: call(request.params) });
    default:
      return respond(request.id, { error: { code: -32601, message: "Method not found" } });
  }
});
