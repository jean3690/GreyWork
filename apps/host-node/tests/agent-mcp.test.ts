/**
 * MCP 工具接入本机 agent：探测 → 注册成函数 → 调用回放。
 *
 * 用 tests/fixtures/fake-mcp-server.mjs 当真实 stdio server（不 mock mcp.ts），
 * 这样 initialize / tools/list / tools/call 的帧格式与超时路径都被真正走一遍。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { mcpToolSchemas, resolveMcpTools, type AgentMcpServer } from "../src/agent-mcp.js";
import { executeTool, type ToolPolicy } from "../src/llm-agent.js";
import { WorkspaceAccess } from "../src/workspace-access.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "fake-mcp-server.mjs");

function workspace(): { root: string; access: WorkspaceAccess } {
  const root = mkdtempSync(path.join(tmpdir(), "gw-agent-mcp-"));
  const access = new WorkspaceAccess(root, path.join(root, ".ledger.json"));
  access.authorizeSelectedPath(root);
  return { root, access };
}

const server: AgentMcpServer = {
  name: "fake",
  transport: "stdio",
  command: process.execPath,
  args: [fixture],
};

const policy = (mcp: "deny" | "ask" | "auto", allow = true): ToolPolicy => ({
  write: "deny",
  shell: "deny",
  mcp,
  confirm: async () => allow,
});

describe("MCP 工具接入", () => {
  it("探测 tools/list 并注册成 mcp__server__tool", async () => {
    const bindings = await resolveMcpTools([server]);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].toolName).toBe("mcp__fake__echo");
    expect(bindings[0].tool).toBe("echo");
    expect(bindings[0].description).toContain("回显");

    const schema = mcpToolSchemas(bindings)[0] as {
      function: { name: string; description: string; parameters: { properties: Record<string, unknown> } };
    };
    expect(schema.function.name).toBe("mcp__fake__echo");
    expect(schema.function.description).toContain("[fake]");
    expect(schema.function.parameters.properties).toHaveProperty("text");
  });

  it("MCP 调用把结果作为工具内容回传", async () => {
    const { root, access } = workspace();
    const bindings = await resolveMcpTools([server]);
    const result = await executeTool(access, root, "mcp__fake__echo", { text: "你好" }, policy("auto"), bindings);
    expect(result.error).toBeNull();
    expect(result.content).toContain("echo: 你好");
    expect(result.summary).toContain("fake/echo");
  });

  it("workspace 档位每次调用都要确认；拒绝时不发请求", async () => {
    const { root, access } = workspace();
    const bindings = await resolveMcpTools([server]);
    const seen: string[] = [];
    const asking: ToolPolicy = {
      write: "deny",
      shell: "deny",
      mcp: "ask",
      confirm: async (request) => {
        seen.push(request.title + " / " + (request.command ?? ""));
        return false;
      },
    };
    const result = await executeTool(access, root, "mcp__fake__echo", { text: "x" }, asking, bindings);
    expect(result.error).toContain("用户拒绝");
    expect(seen[0]).toContain("fake / echo");
    expect(seen[0]).toContain("echo");
  });

  it("只读档位直接拒绝 MCP 调用", async () => {
    const { root, access } = workspace();
    const bindings = await resolveMcpTools([server]);
    const result = await executeTool(access, root, "mcp__fake__echo", { text: "x" }, policy("deny"), bindings);
    expect(result.error).toContain("不允许调用 MCP");
  });
});
