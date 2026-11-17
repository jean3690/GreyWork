import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/events.js";
import { LlmAgentHost } from "../src/llm-agent.js";
import { WorkspaceAccess } from "../src/workspace-access.js";

let root: string;
let host: LlmAgentHost;
let events: { kind: string; payload: Record<string, unknown> }[];
const active = new Set<number>();
const completion = (content: string, calls?: unknown[], reasoning?: string) =>
  Response.json({ choices: [{ message: { content, tool_calls: calls, reasoning_content: reasoning } }] });
const call = (id: string, name: string, args: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const start = (token = "turn", options = {}) => {
  const id = host.start({
    baseUrl: "https://gateway.example/openai",
    model: "custom",
    messages: [{ role: "user", content: "read then edit" }],
    clientToken: token,
    ...options,
  });
  active.add(id);
  return id;
};
const terminal = (token = "turn") =>
  events.find((event) => event.payload.clientToken === token && ["llm-done", "llm-error"].includes(event.kind));

beforeEach(() => {
  root = mkdtempSync("/tmp/opencode/gw-agent-loop-");
  writeFileSync(path.join(root, "a.txt"), "before");
  const access = new WorkspaceAccess(root, path.join(root, "ledger.json"));
  access.authorizeSelectedPath(root);
  const bus = new EventBus();
  events = [];
  vi.spyOn(bus, "broadcast").mockImplementation((_name, payload) => {
    events.push(payload as (typeof events)[number]);
  });
  host = new LlmAgentHost(bus, access);
});
afterEach(() => {
  for (const id of active) {
    try {
      host.stop(id);
    } catch {
      /* 已完成 */
    }
  }
  active.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("原生 agent loop", () => {
  it("真实 HTTP 兼容网关：自定义路径、Bearer 鉴权、SSE 工具回填和 JSON 收尾", async () => {
    vi.stubEnv("GREYWORK_NATIVE_LOOP_TEST_KEY", "test-native-key");
    let count = 0;
    const server = createServer(async (req, res) => {
      expect(req.url).toBe("/proxy/chat/completions");
      expect(req.headers.authorization).toBe("Bearer test-native-key");
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw);
      if (count++ === 0) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          "data: " +
            JSON.stringify({
              choices: [{ delta: { tool_calls: [{ index: 0, id: "http-read", function: { name: "read_file", arguments: '{"path":' } }] } }],
            }) +
            "\r\n\r\n",
        );
        res.end(
          "data: " +
            JSON.stringify({
              choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: "tool_calls" }],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      } else {
        expect(body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "http-read", content: "before" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "HTTP loop done" }, finish_reason: "stop" }] }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      start("turn", {
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/proxy`,
        apiKeyEnv: "GREYWORK_NATIVE_LOOP_TEST_KEY",
      });
      await vi.waitFor(() => expect(terminal()?.kind).toBe("llm-done"));
      expect(count).toBe(2);
      expect(events.find((e) => e.kind === "llm-tool-result")?.payload.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  it("被 token 上限截断的写调用不会执行", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [
            { message: { tool_calls: [call("write1", "write_file", { path: "a.txt", content: "lost" })] }, finish_reason: "length" },
          ],
        }),
      ),
    );
    start("turn", { permissionTier: "full" });
    await vi.waitFor(() => expect(terminal()?.kind).toBe("llm-error"));
    expect(String(terminal()?.payload.message)).toContain("token 上限");
    expect(events.some((e) => e.kind === "llm-tool-call")).toBe(false);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("before");
  });
  it("第三方模型多轮读写工具、推理回填和收尾回答", async () => {
    let round = 0;
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: "custom", stream: false, top_p: 0.8 });
      if (round++ === 0) return completion("", [call("read1", "read_file", { path: "a.txt" })], "先查看原文");
      expect(body.messages.find((m: { role: string }) => m.role === "tool").content).toBe("before");
      expect(body.messages.find((m: { tool_calls?: unknown }) => m.tool_calls).reasoning_content).toBe("先查看原文");
      if (round === 2) return completion("", [call("edit1", "edit_file", { path: "a.txt", old_text: "before", new_text: "after" })]);
      return completion("修改完成");
    });
    vi.stubGlobal("fetch", fetch);
    start("turn", { permissionTier: "full", stream: false, extraBody: { top_p: 0.8 } });
    await vi.waitFor(() => expect(terminal()?.kind).toBe("llm-done"));
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("after");
    expect(events.filter((e) => e.kind === "llm-tool-result")).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("取消 A 只裁决 A 的权限，不拒绝 B，也不执行 A 后续工具", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.messages.some((m: { role: string }) => m.role === "tool")) return completion("done");
        return completion("", [
          call("write1", "write_file", { path: "a.txt", content: "changed" }),
          call("write2", "write_file", { path: "a.txt", content: "should not run" }),
        ]);
      }),
    );
    const a = start("A", { permissionTier: "workspace" });
    start("B", { permissionTier: "workspace" });
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "permission-request")).toHaveLength(2));
    host.stop(a);
    active.delete(a);
    const resolved = events.filter((e) => e.kind === "permission-resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].payload.clientToken).toBe("A");
    const b = events.find((e) => e.kind === "permission-request" && e.payload.clientToken === "B")!;
    expect(host.respondPermission(Number(b.payload.requestId), "deny")).toBe(true);
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "permission-request" && e.payload.clientToken === "B")).toHaveLength(2));
    const b2 = events.filter((e) => e.kind === "permission-request" && e.payload.clientToken === "B")[1];
    host.respondPermission(Number(b2.payload.requestId), "deny");
    await vi.waitFor(() => expect(terminal("B")?.kind).toBe("llm-done"));
    expect(events.filter((e) => e.kind === "llm-tool-call" && e.payload.clientToken === "A")).toHaveLength(1);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("before");
  });

  it("轮数用尽发 tool_choice=none，且保留工具声明", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return bodies.length === 1 ? completion("", [call("read1", "read_file", { path: "a.txt" })]) : completion("结论");
      }),
    );
    start("turn", { maxRounds: 1 });
    await vi.waitFor(() => expect(terminal()?.kind).toBe("llm-done"));
    expect(bodies[1].tool_choice).toBe("none");
    expect(bodies[1].tools).toEqual(bodies[0].tools);
  });

  it("主供应商失败时按备用供应商重建模型/扩展参数/stream", async () => {
    const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
      if (String(url).includes("primary")) return new Response("rate limit", { status: 429 });
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "backup-model", top_p: 0.4, stream: false });
      return completion("备用模型回答");
    });
    vi.stubGlobal("fetch", fetch);
    start("turn", {
      providers: [
        { baseUrl: "https://primary.example/v1", model: "primary-model", extraBody: { top_p: 0.9 } },
        { baseUrl: "https://backup.example/api", model: "backup-model", stream: false, extraBody: { top_p: 0.4 } },
      ],
    });
    await vi.waitFor(() => expect(terminal()?.kind).toBe("llm-done"));
    expect(events.find((e) => e.kind === "llm-provider-switch")?.payload.to).toBe("backup-model");
  });
});
