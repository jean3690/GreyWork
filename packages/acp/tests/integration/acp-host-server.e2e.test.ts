/**
 * 跨语言 ACP 门禁：**真实的渲染端 ACP client** × **真实的 Rust 宿主**。
 *
 * 为什么需要它：`@agentclientprotocol/sdk`（渲染端，TS）与 `agent-client-protocol`（Rust）
 * 是两套独立实现、两条独立版本线。升级任一侧时，编译过、单测过都不能说明「两边接得上」——
 * `packages/acp` 的单元测试只对着注入的 `FakeWebSocket` 断言帧，Rust 侧的 ACP 测试则全是
 * Rust ↔ agent，两边之间**没有任何自动化验证**（详见 docs/architecture.md 的 Testing 段）。
 *
 * 链路：`createAcpClient()` → `TauriIpcTransport` → `@greywork/host-ipc` 的
 * `POST /api/command` + `WS /api/events` → 真 `greywork-server` → `AcpHost` → spawn 假 agent
 * （复用 `apps/desktop/src-tauri/tests/mock-acp-agent.mjs`），跑通
 * initialize → session/new → session/prompt → agent_message_chunk → prompt-done。
 *
 * Node 侧不改任何生产代码：`@greywork/host-ipc` 的 `runtime.ts` 本来就有给测试用的显式
 * 覆盖键 `window.__GREYWORK_RUNTIME__`，`auth.rs` 的 `AuthSession` 先认 Bearer、`events.rs`
 * 的 WS 也接受 `?token=`。本文件只是在 Node 里把浏览器本来白送的那几件事（同源相对
 * URL、cookie 随请求、WS 带 cookie）显式补上。
 *
 * 依赖 `target/debug/greywork-server`（先 `cargo build -p greywork-server`）。
 * 本测试**不会**替你构建，缺产物直接报错并给出命令。刻意不设 `GREYWORK_STATIC_DIR`：
 * 只走 `/api`，不需要前端构建产物。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_HELLO_EVENT, listen } from "@greywork/host-ipc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAcpClient, type AcpClient } from "../../src/index";
import type { AcpEventEnvelope, AcpPromptResult } from "../../src/transports";

const PORT = Number(process.env.GREYWORK_ACP_E2E_PORT ?? 8896);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "acp-e2e-secret";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const serverBin = join(repoRoot, "target/debug/greywork-server");
const mockAgent = join(repoRoot, "apps/desktop/src-tauri/tests/mock-acp-agent.mjs");

/** 假 agent 的固定应答，来自 mock-acp-agent.mjs。 */
const MOCK_SESSION_ID = "sess-mock-001";

/* ===== 宿主事件载荷（与 crates/greywork-host/src/acp_host.rs 的 emit 对齐） ===== */

interface StartedPayload {
  handle: number;
}
interface SessionNewPayload {
  handle: number;
  sessionId: string;
}
interface ChunkPayload {
  sessionId: string;
  update: { sessionUpdate: string; content: { type: string; text?: string } };
}
interface PromptDonePayload {
  handle: number;
  turnId: number;
  response?: AcpPromptResult;
  error?: string;
}
interface StoppedPayload {
  handle: number;
}

/* ===== 小工具 ===== */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待；超时把 label 与「怎么排查」一起抛出去，避免只看到一句干巴巴的 timeout。 */
async function waitUntil(pred: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error(`等待超时（${label}）`);
}

/** 缺产物时的提示要能直接照抄执行，否则这条门禁只会被当成「环境坏了」。 */
function requireArtifacts(): void {
  const missing: string[] = [];
  if (!existsSync(serverBin)) missing.push(`  cargo build -p greywork-server   # 缺 ${serverBin}`);
  if (!existsSync(mockAgent)) missing.push(`  预期存在的假 agent 不见了：${mockAgent}`);
  if (missing.length > 0) throw new Error(`缺少构建产物，先跑：\n${missing.join("\n")}`);
}

/* ===== 被替换的全局（afterAll 逐个还原） ===== */

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
let serverLog = "";
let server: ChildProcess | undefined;
let client: AcpClient | undefined;
let unlistenHello: (() => void) | undefined;
let unlistenEvents: (() => void) | undefined;
const events: AcpEventEnvelope[] = [];
let helloSeen = false;
let handle = 0;
let dataDir = "";
let homeDir = "";

/** 收不到 `acp://event` 时把已收事件与宿主日志一起抛出来，否则只剩「断言失败」四个字。 */
async function waitForEvent(kind: string, label: string, from = 0): Promise<AcpEventEnvelope> {
  let found: AcpEventEnvelope | undefined;
  try {
    await waitUntil(() => {
      found = events.slice(from).find((event) => event.kind === kind);
      return found !== undefined;
    }, `${kind}（${label}）`);
  } catch (error) {
    const seen = events.map((event) => `  ${event.kind} ${JSON.stringify(event.payload).slice(0, 300)}`).join("\n");
    throw new Error(
      `${(error as Error).message}\n已收到 ${events.length} 条事件：\n${seen}` +
        (serverLog ? `\n--- greywork-server 日志尾部 ---\n${serverLog.slice(-2000)}` : ""),
      // 带上 cause：这句只是给超时加诊断上下文，原始错误（waitUntil 的 timeout）不该丢。
      { cause: error },
    );
  }
  return found as AcpEventEnvelope;
}

describe("跨语言 ACP：渲染端 client → 真服务端 → 真宿主 → 假 agent", () => {
  beforeAll(async () => {
    requireArtifacts();
    // `events.ts:71` 在缺 WebSocket / location 时会**静默不连**。先把它变成显式失败，
    // 否则症状退化成「等 host://hello 超时」，很难看出其实是 Node 版本不够（需 ≥22）。
    if (typeof realWebSocket !== "function") {
      throw new Error(`本门禁需要 Node ≥22 的原生 WebSocket，当前 ${process.version}`);
    }

    dataDir = mkdtempSync(join(tmpdir(), "gw-acp-e2e-data-"));
    homeDir = mkdtempSync(join(tmpdir(), "gw-acp-e2e-home-"));

    server = spawn(serverBin, [], {
      // shell: false → 普通 SIGTERM 就能收干净（没有 sh 垫片，也就没有孙进程握着管道的问题）。
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GREYWORK_BIND: `127.0.0.1:${PORT}`,
        GREYWORK_DATA_DIR: dataDir,
        GREYWORK_HOME_DIR: homeDir,
        GREYWORK_PASSWORD: PASSWORD,
        // 沙盒在 CI 里不可用，显式关掉；顺带让 `policy::overlay_args` 把它钉成 off。
        GREYWORK_SANDBOX: "off",
        // 同理钉住档位。注意：这条门禁**不验证**档位语义（echo 流程不发权限请求）。
        GREYWORK_TIER: "read-only",
      },
    });
    server.stdout?.on("data", (chunk: Buffer) => (serverLog += chunk.toString()));
    server.stderr?.on("data", (chunk: Buffer) => (serverLog += chunk.toString()));

    let healthy = false;
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      try {
        const response = await realFetch(`${BASE}/api/health`);
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        // 还没起来
      }
      await sleep(200);
    }
    if (!healthy) {
      throw new Error(
        `greywork-server 未在 30s 内就绪（${BASE}/api/health）。` +
          `端口 ${PORT} 被占用也会长这样。\n--- 日志尾部 ---\n${serverLog.slice(-2000)}`,
      );
    }

    const login = await realFetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    if (!login.ok) throw new Error(`登录失败：HTTP ${login.status}`);
    const token = ((await login.json()) as { token: string }).token;

    /* ===== Node 运行时 shim：把浏览器白送的那几件事显式补上 ===== */

    // 1) 运行时三态覆盖：defaultTransport() 因此选 TauriIpcTransport，而不是 WebSocketTransport。
    (globalThis as unknown as Record<string, unknown>).window = { __GREYWORK_RUNTIME__: "server" };
    // 2) events.ts 用 location 拼 WS 地址（同源）。
    (globalThis as unknown as Record<string, unknown>).location = {
      protocol: "http:",
      host: `127.0.0.1:${PORT}`,
    };
    // 3) HTTP：相对 "/api/..." 绝对化 + 带 Bearer（服务端 AuthSession 先认 Bearer、后认 cookie；
    //    Node 的 fetch 没有浏览器那种自动 cookie jar，只能自己带）。
    globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return realFetch(url.startsWith("/") ? `${BASE}${url}` : url, { ...init, headers });
    }) as typeof fetch;
    // 4) WS：浏览器 WS API 不能设请求头，改用服务端支持的 `?token=`（routes/events.rs 的
    //    `token_from_query`）。token 错就是握手 401 → 不升级 → 下面 host://hello 屏障超时。
    class AuthedWebSocket extends (realWebSocket as unknown as new (url: string, protocols?: string | string[]) => WebSocket) {
      constructor(url: string, protocols?: string | string[]) {
        const authed = url.includes("/api/events") ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : url;
        super(authed, protocols);
      }
    }
    (globalThis as unknown as Record<string, unknown>).WebSocket = AuthedWebSocket;

    client = createAcpClient();

    // 订阅顺序很重要：`listen` 会顺带建立 WS，所以**先**挂 hello 处理器再挂事件收集器，
    // 保证首帧 `host://hello` 不会被漏掉（服务端不重放事件）。
    unlistenHello = await listen(HOST_HELLO_EVENT, () => {
      helloSeen = true;
    });
    unlistenEvents = await client.onEvent((event) => {
      events.push(event);
    });

    await waitUntil(() => helloSeen, "WS 就绪帧 host://hello（超时通常意味着 WS 鉴权失败或根本没连上）");

    // 会话的工作目录：服务端启动时创建的默认已授权根，同时满足 validate_existing 与 validate_cwd。
    const cwd = join(homeDir, ".greyWork");
    handle = await client.startAgent(`node "${mockAgent.replace(/\\/g, "/")}"`, "read-only", "off", cwd);
  });

  afterAll(async () => {
    if (client && handle) {
      await client.stop(handle).catch(() => undefined);
    }
    unlistenHello?.();
    unlistenEvents?.();
    (globalThis as unknown as Record<string, unknown>).window = undefined;
    (globalThis as unknown as Record<string, unknown>).location = undefined;
    globalThis.fetch = realFetch;
    (globalThis as unknown as Record<string, unknown>).WebSocket = realWebSocket;
    server?.kill("SIGTERM");
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  });

  it("传输层走宿主 IPC，而不是远程 WebSocket 分支", () => {
    // 这条断言是整条门禁的「防伪」：`window.__GREYWORK_RUNTIME__` 没生效的话，client 会
    // 落到 WebSocketTransport（未配置 url → 每个操作抛 RemoteAcpUnsupportedError）。
    // 不显式断言就可能出现「测试通过但其实没走被测路径」。
    expect(client?.transportId).toBe("tauri-ipc");
    expect(client?.isAvailable()).toBe(true);
  });

  it("initialize → session/new → prompt → chunk → prompt-done 全链路", async () => {
    const acp = client as AcpClient;

    // initialize 的结果体现为 started 事件（宿主在 initialize 成功后才 emit）。
    const started = await waitForEvent("started", "宿主完成 initialize");
    expect((started.payload as StartedPayload).handle).toBe(handle);

    const cwd = join(homeDir, ".greyWork");
    const opened = await acp.openSession(handle, cwd);
    expect(opened.sessionId).toBe(MOCK_SESSION_ID);
    // 假 agent 在 session/new 里回了一个 model 选择器 —— 证明 configOptions 这条通路也通。
    expect(opened.configOptions.some((option) => option.id === "model")).toBe(true);

    const sessionNew = await waitForEvent("session-new", "session/new 回执");
    expect((sessionNew.payload as SessionNewPayload).sessionId).toBe(MOCK_SESSION_ID);

    // 顺带验证 acp_list 这条独立命令：handle 在册且已经挂了会话。
    const sessions = await acp.list();
    expect(sessions.some((session) => session.handle === handle && session.hasSession)).toBe(true);

    const chunkFrom = events.length;
    const { turnId } = await acp.prompt(handle, "hello acp gate");

    // 核心跨语言断言：TS SDK 发出的 session/prompt 被 Rust 解析、假 agent 真被 spawn、
    // 回复经 WS 回到 TS 客户端。三者缺一这句话都对不上。
    const chunk = await waitForEvent("session-update", "agent_message_chunk", chunkFrom);
    const chunkPayload = chunk.payload as ChunkPayload;
    expect(chunkPayload.sessionId).toBe(MOCK_SESSION_ID);
    expect(chunkPayload.update.sessionUpdate).toBe("agent_message_chunk");
    expect(chunkPayload.update.content.text).toBe("echo: hello acp gate");

    const done = await waitForEvent("prompt-done", "回合结束", chunkFrom);
    const donePayload = done.payload as PromptDonePayload;
    expect(donePayload.handle).toBe(handle);
    expect(donePayload.turnId).toBe(turnId);
    expect(donePayload.error).toBeUndefined();
    // 显式断言 stopReason：宿主失败时给的是 `{error}`，宽松匹配会把它放过去。
    expect(donePayload.response?.stopReason).toBe("end_turn");

    // 顺序：流式 chunk 必须早于回合结束，否则「prompt-done 先到、内容后到」这类回归会被漏掉。
    const chunkIndex = events.indexOf(chunk);
    const doneIndex = events.indexOf(done);
    expect(chunkIndex).toBeLessThan(doneIndex);
  });

  it("白名单外的 agent 程序被宿主拒绝（真实 process_guard 在请求路径上）", async () => {
    const acp = client as AcpClient;
    const cwd = join(homeDir, ".greyWork");
    // 不 spawn 任何进程：校验在 validate_spawn_command 就拦下了。
    await expect(acp.startAgent("definitely-not-allowed-agent acp", "read-only", "off", cwd)).rejects.toThrow(/is not in the allowed list/);
  });

  it("stop 回收会话并发出 stopped", async () => {
    const acp = client as AcpClient;
    await acp.stop(handle);
    const stopped = await waitForEvent("stopped", "宿主回收会话进程树");
    expect((stopped.payload as StoppedPayload).handle).toBe(handle);
    handle = 0;
  });
});
