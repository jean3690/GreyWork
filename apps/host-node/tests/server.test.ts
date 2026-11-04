import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo as NodeAddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { LoginThrottle, SessionStore, passwordChecker } from "../src/auth.js";
import { AcpHost } from "../src/acp.js";
import { Db } from "../src/db.js";
import { RagIndexHost } from "../src/rag.js";
import { isDenied } from "../src/commands.js";
import { EventBus } from "../src/events.js";
import { LlmStreamHost } from "../src/llm.js";
import { SessionFileStore } from "../src/session-store.js";
import { TerminalHost } from "../src/terminal.js";
import { loadConfig } from "../src/config.js";
import { createHostServer } from "../src/server.js";
import { resolveStaticRoot } from "../src/static-site.js";
import { WorkspaceAccess } from "../src/workspace-access.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "gw-host-node-data-"));
const workspaceDir = mkdtempSync(path.join(tmpdir(), "gw-host-node-ws-"));
writeFileSync(path.join(workspaceDir, "hello.txt"), "hello parity\n");
mkdirSync(path.join(workspaceDir, "sub"), { recursive: true });

const staticDir = mkdtempSync(path.join(tmpdir(), "gw-host-node-"));
mkdirSync(path.join(staticDir, "assets"), { recursive: true });
writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>greywork-host-node</title>");
writeFileSync(path.join(staticDir, "assets", "app.js"), "console.log(1)");

const config = loadConfig({
  GREYWORK_BIND: "127.0.0.1:0",
  GREYWORK_PASSWORD: "test-password",
  GREYWORK_STATIC_DIR: staticDir,
  GREYWORK_SESSION_TTL: "3600",
  GREYWORK_DATA_DIR: dataDir,
  GREYWORK_WORKSPACE_ROOTS: workspaceDir,
  // 与桌面端口径一致：可信宿主才放行 terminal_* / shell_run。
  GREYWORK_TRUSTED_HOST: "1",
});

const sessions = new SessionStore(passwordChecker(config), config.sessionTtlSecs);
const throttle = new LoginThrottle();
// 本地 OpenAI 兼容 mock：模型清单 / 向量 / SSE 补全 / 转写各一条路由。
const provider = createHttpServer((request, response) => {
  const url = request.url ?? "";
  if (request.method === "GET" && url.endsWith("/v1/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }] }));
    return;
  }
  if (request.method === "POST" && url.endsWith("/v1/embeddings")) {
    // embedding 数量必须与 input 一致（宿主按批校验），按请求体长度返回。
    let body = "";
    request.on("data", (chunk: Buffer) => (body += String(chunk)));
    request.on("end", () => {
      const input = (JSON.parse(body || "{}") as { input?: unknown[] }).input ?? [];
      const embeddings = (input as unknown[]).map((_value, index) => [index + 1, 2, 3]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: embeddings.map((embedding) => ({ embedding })) }));
    });
    return;
  }
  if (request.method === "POST" && url.endsWith("/v1/chat/completions")) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    response.end("data: [DONE]\n\n");
    return;
  }
  if (request.method === "POST" && url.endsWith("/v1/audio/transcriptions")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: "transcribed" }));
    return;
  }
  response.writeHead(404).end();
});

const access = new WorkspaceAccess(workspaceDir, path.join(dataDir, "workspace-path-access.json"));
for (const root of config.workspaceRoots) access.authorizeSelectedPath(root);
const db = new Db(path.join(dataDir, "greywork.db"));
const bus = new EventBus();
const store = new SessionFileStore(access);
const acp = new AcpHost(bus, access);
const llm = new LlmStreamHost(bus);
const rag = new RagIndexHost(db);
const terminal = new TerminalHost(bus, access);

const { server, close } = createHostServer({
  config,
  sessions,
  throttle,
  staticRoot: resolveStaticRoot(config.staticDir),
  access,
  acp,
  db,
  rag,
  store,
  llm,
  bus,
  terminal,
  extraPrograms: (trustedHost: boolean) => (trustedHost ? ["mock-agent"] : []),
});

let base = "";
let cookie = "";

async function login(): Promise<string> {
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  expect(response.status).toBe(200);
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

beforeAll(async () => {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = await login();
});

afterAll(async () => {
  terminal.disposeAll();
  await close();
  db.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

describe("HTTP 契约", () => {
  it("健康检查免鉴权，字段与 Rust 一致", async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });

  it("未登录访问受保护端点回 401 + {error}", async () => {
    for (const [method, route] of [
      ["GET", "/api/commands"],
      ["GET", "/api/session"],
      ["POST", "/api/command"],
    ] as const) {
      const response = await fetch(`${base}${route}`, { method });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "未认证" });
    }
  });

  it("密码错误回 401，且不下发 cookie", async () => {
    const response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("/api/commands 返回 189 条，只有已迁移的命令标 available", async () => {
    const response = await fetch(`${base}/api/commands`, { headers: { cookie } });
    const list = (await response.json()) as { name: string; available: boolean; desktopOnly: boolean }[];
    expect(list).toHaveLength(189);
    const defaultRoot = list.find((item) => item.name === "store_default_root");
    expect(defaultRoot?.available).toBe(true);
    // 桌面专属命令任何宿主都不可调用。
    expect(list.find((item) => item.name === "reveal_path")?.available).toBe(false);
    // 尚未迁移的普通命令：可用性必须是 false，避免前端「点了才报错」。
    expect(list.find((item) => item.name === "git_stage")?.available).toBe(false);
    // 可信宿主下 terminal_shells 已迁移且允许调用。
    expect(list.find((item) => item.name === "terminal_shells")?.available).toBe(true);
  });

  it("已迁移命令走真实实现", async () => {
    const response = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "store_default_root" }),
    });
    expect(response.status).toBe(200);
    const root = (await response.json()) as string;
    // 测试把默认根换成临时工作区（生产是 ~/.greyWork）；只校验「回的是授权根本体」。
    expect(root).toBe(realpathSync(workspaceDir));
  });

  it("未知命令 400、桌面专属 403、未迁移 501（错误信封一致）", async () => {
    const call = async (command: string) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command }),
      });
      return { status: response.status, body: (await response.json()) as { error: string } };
    };
    const unknown = await call("definitely_not_a_command");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toContain("未知命令");

    const desktop = await call("reveal_path");
    expect(desktop.status).toBe(403);

    const unmigrated = await call("git_stage");
    expect(unmigrated.status).toBe(501);
    expect(unmigrated.body.error).toContain("尚未迁移");

    // 非可信宿主只在单测里验策略（主 server 以桌面口径开着可信开关）。
    expect(isDenied("terminal_shells", false)).toBe(true);
    expect(isDenied("terminal_shells", true)).toBe(false);
  });

  it("fs_list_dir / fs_read_text_file 走授权面", async () => {
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    const listed = await call("fs_list_dir", { path: workspaceDir });
    expect(listed.status).toBe(200);
    const entries = listed.body as { name: string; kind: string; size: number | null }[];
    expect(entries.map((entry) => entry.name).sort()).toEqual(["hello.txt", "sub"]);
    expect(entries.find((entry) => entry.name === "sub")).toMatchObject({ kind: "directory", size: null });
    expect(entries.find((entry) => entry.name === "hello.txt")?.kind).toBe("file");

    const text = await call("fs_read_text_file", { path: path.join(workspaceDir, "hello.txt") });
    expect(text.status).toBe(200);
    expect(text.body).toBe("hello parity\n");
  });

  it("写面：写文本 / 建目录 / 建文件 / 撞名拒绝", async () => {
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };
    const target = path.join(workspaceDir, "written.txt");
    expect((await call("fs_write_text_file", { path: target, content: "written\n" })).status).toBe(200);
    expect((await call("fs_read_text_file", { path: target })).body).toBe("written\n");

    expect((await call("fs_ensure_dir", { path: path.join(workspaceDir, "made", "deep") })).status).toBe(200);
    expect((await call("fs_create_dir", { path: path.join(workspaceDir, "fresh") })).status).toBe(200);
    expect((await call("fs_create_file", { path: path.join(workspaceDir, "fresh", "a.txt") })).status).toBe(200);

    // 撞名必须失败（create_new / mkdir 语义），不能静默覆盖。
    const collision = await call("fs_create_file", { path: path.join(workspaceDir, "fresh", "a.txt") });
    expect(collision.status).toBe(400);
    expect((collision.body as { error: string }).error).toContain("新建文件失败");

    // 越界写：授权面之外一律 400。
    const outside = await call("fs_write_text_file", { path: "/tmp/gw-should-not-exist.txt", content: "x" });
    expect(outside.status).toBe(400);
    expect((outside.body as { error: string }).error).toContain("未获用户授权");
  });

  it("删除 / 改名 / 复制：撞名与越界都要拦，授权根不许动", async () => {
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: (await response.json()) as { error?: string } };
    };
    const dir = path.join(workspaceDir, "transfer");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "victim.txt"), "bye");
    writeFileSync(path.join(dir, "before.txt"), "move me");
    writeFileSync(path.join(dir, "copy-src.txt"), "copy me");

    expect((await call("fs_copy_path", { from: path.join(dir, "copy-src.txt"), to: path.join(dir, "copy-dst.txt") })).status).toBe(200);
    expect(readFileSync(path.join(dir, "copy-dst.txt"), "utf8")).toBe("copy me");

    const copyCollision = await call("fs_copy_path", { from: path.join(dir, "copy-src.txt"), to: path.join(dir, "copy-dst.txt") });
    expect(copyCollision.status).toBe(400);
    expect(copyCollision.body.error).toContain("目标已存在");

    expect((await call("fs_rename_path", { from: path.join(dir, "before.txt"), to: path.join(dir, "after.txt") })).status).toBe(200);
    expect(existsSync(path.join(dir, "after.txt"))).toBe(true);
    expect(existsSync(path.join(dir, "before.txt"))).toBe(false);

    expect((await call("fs_delete_path", { path: path.join(dir, "victim.txt") })).status).toBe(200);
    expect(existsSync(path.join(dir, "victim.txt"))).toBe(false);

    // 授权根本身不许删（否则账本指向不存在的目录）。
    const rootDelete = await call("fs_delete_path", { path: workspaceDir });
    expect(rootDelete.status).toBe(400);
    expect(rootDelete.body.error).toContain("已授权的工作区根目录");
  });

  it("git 只读四条：status / changes / diff / current_branch", async () => {
    const repo = path.join(workspaceDir, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(path.join(repo, "untracked.txt"), "new\n");

    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    const branch = await call("git_current_branch", { root: repo });
    expect(branch.body).toBe("main");

    const status = (await call("git_status", { root: repo })).body as { path: string; status: string }[];
    expect(status.find((item) => item.path === "a.txt")?.status).toBe("modified");
    expect(status.find((item) => item.path === "untracked.txt")?.status).toBe("untracked");

    const changes = (await call("git_changes", { root: repo })).body as {
      path: string;
      index: string | null;
      worktree: string | null;
      add: number;
    }[];
    const modified = changes.find((item) => item.path === "a.txt");
    expect(modified?.worktree).toBe("modified");
    expect(modified?.index).toBeNull();
    expect(modified?.add).toBe(1);

    const diff = (await call("git_diff", { root: repo, path: "a.txt", staged: false })).body as string;
    expect(diff).toContain("+two");

    // 越界路径（`..` / 绝对路径）必须在跑 git 之前就被拒。
    const escaped = await call("git_diff", { root: repo, path: "../outside.txt", staged: false });
    expect(escaped.status).toBe(400);
    expect((escaped.body as { error: string }).error).toContain("非法路径");
  });

  it("fs_probe_file / fs_read_binary：文本与二进制分流，二进制走原始字节", async () => {
    const callRaw = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return response;
    };

    const text = path.join(workspaceDir, "hello.txt");
    const probeText = (await (await callRaw("fs_probe_file", { path: text })).json()) as {
      size: number;
      binary: boolean;
      utf8: boolean;
      bom: boolean;
    };
    expect(probeText).toMatchObject({ size: 13, binary: false, utf8: true, bom: false });

    const binPath = path.join(workspaceDir, "bin.dat");
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]);
    writeFileSync(binPath, payload);
    const probeBin = (await (await callRaw("fs_probe_file", { path: binPath })).json()) as { binary: boolean };
    expect(probeBin.binary).toBe(true);

    const response = await callRaw("fs_read_binary", { path: binPath });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-greywork-binary")).toBe("1");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(payload)).toBe(true);
  });

  it("fs_write_binary / fs_read_media：base64 写入与媒体原始字节", async () => {
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return response;
    };

    const target = path.join(workspaceDir, "written.bin");
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    expect((await call("fs_write_binary", { path: target, dataBase64: payload.toString("base64") })).status).toBe(200);
    expect(readFileSync(target).equals(payload)).toBe(true);

    const media = await call("fs_read_media", { path: target, maxBytes: 1024 * 1024 });
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer()).equals(payload)).toBe(true);

    // 超过调用方给的额度必须报错而不是截断（半截视频在播放器里表现为「格式损坏」）。
    const tooSmall = await call("fs_read_media", { path: target, maxBytes: 2 });
    expect(tooSmall.status).toBe(400);
    expect(((await tooSmall.json()) as { error: string }).error).toContain("上限");
  });

  it("store_sessions：未接管回 null → 同步 → 读回 → 冲突 → 删除", async () => {
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    expect((await call("store_sessions_load", { workspaces: [] })).body).toBeNull();

    const snapshot = {
      sessions: [
        { id: "s1", title: "one", workspaceId: null, createdAt: 900, updatedAt: 1000, messages: [] },
        { id: "s2", title: "two", workspaceId: null, createdAt: 1900, updatedAt: 2000, messages: [] },
      ],
      activeSessionId: "s2",
    };
    const first = await call("store_sessions_sync", { snapshot, workspaces: [], deletedSessionIds: [] });
    expect(first.body).toEqual({ written: 2, skipped: 0, deleted: 0, conflicts: [] });

    const loaded = await call("store_sessions_load", { workspaces: [] });
    expect(loaded.body).toEqual({ sessions: [snapshot.sessions[1], snapshot.sessions[0]], activeSessionId: "s2" });

    // 内容没变 → 全部 skipped（不重复落盘）。
    const again = await call("store_sessions_sync", { snapshot, workspaces: [], deletedSessionIds: [] });
    expect((again.body as { skipped: number }).skipped).toBe(2);

    // 磁盘更晚 → 冲突且不覆盖。
    const stale = await call("store_sessions_sync", {
      snapshot: {
        sessions: [{ id: "s1", title: "stale", workspaceId: null, createdAt: 400, updatedAt: 500, messages: [] }],
        activeSessionId: "s1",
      },
      workspaces: [],
      deletedSessionIds: [],
    });
    expect((stale.body as { conflicts: { id: string }[] }).conflicts.map((item) => item.id)).toEqual(["s1"]);
    const afterConflict = await call("store_sessions_load", { workspaces: [] });
    expect((afterConflict.body as { sessions: { id: string; title: string }[] }).sessions.find((item) => item.id === "s1")?.title).toBe(
      "one",
    );

    // 只删显式列出的 id。
    const deleted = await call("store_sessions_sync", {
      snapshot: { sessions: [], activeSessionId: null },
      workspaces: [],
      deletedSessionIds: ["s1"],
    });
    expect((deleted.body as { deleted: number }).deleted).toBe(1);
    const final = await call("store_sessions_load", { workspaces: [] });
    expect((final.body as { sessions: { id: string }[] }).sessions.map((item) => item.id)).toEqual(["s2"]);

    expect((await call("attachments_prune_session", { sessionId: "s1" })).status).toBe(200);
    // 非法 id 必须拒绝（附件目录是「渲染端能调删除」的命令）。
    expect((await call("attachments_prune_session", { sessionId: "../etc" })).status).toBe(400);
  });

  it("db_agents：未接管回 null → 同步 → 读回 → 删除缺失项", async () => {
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    expect((await call("db_agents_load", {})).body).toBeNull();
    const providers = [
      { id: "p1", name: "Agent One", kind: "acp", command: "git --acp", enabled: true, env: null },
      { id: "p2", name: "Agent Two", kind: "acp", command: "npx -y agent", enabled: false, env: '{"K":"V"}' },
    ];
    expect((await call("db_agents_sync", { providers })).status).toBe(200);
    expect((await call("db_agents_load", {})).body).toEqual(providers);

    // 少一个 → 缺失项被删（全量替换语义）。
    expect((await call("db_agents_sync", { providers: [providers[0]] })).status).toBe(200);
    expect((await call("db_agents_load", {})).body).toEqual([providers[0]]);
  });

  it("acp_detect_programs 按 PATH 探测，acp_list 无会话时为空", async () => {
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };
    const probes = (await call("acp_detect_programs", { programs: ["git", "definitely-not-a-program-xyz", "  "] })).body as {
      program: string;
      installed: boolean;
      path: string | null;
      bundled: boolean;
    }[];
    expect(probes).toHaveLength(2);
    expect(probes[0]).toMatchObject({ program: "git", installed: true, bundled: false });
    expect(probes[0].path?.endsWith("git")).toBe(true);
    expect(probes[1]).toMatchObject({ program: "definitely-not-a-program-xyz", installed: false, path: null });

    expect((await call("acp_list", {})).body).toEqual([]);
  });

  it("db_automations / runs / team_runs：同步、读回与运行记录", async () => {
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    const task = {
      id: "a1",
      name: "每日摘要",
      schedule: "每天 09:00",
      cron: "0 9 * * *",
      target: "",
      intent: "summarize",
      enabled: true,
      lastRun: 0,
      acpProviderId: null,
      onceAt: null,
    };
    expect((await call("db_automations_load", {})).body).toBeNull();
    expect((await call("db_automations_sync", { tasks: [task] })).status).toBe(200);
    expect((await call("db_automations_load", {})).body).toEqual([task]);
    expect((await call("db_automations_due_list", {})).body).toEqual([]);
    expect((await call("db_automations_due_finish", { id: 999, status: "success" })).body).toBe(false);

    expect(
      (
        await call("db_automation_run_record", {
          run: { taskId: "a1", name: task.name, status: "success", detail: "ok", sessionId: null, mode: "llm", ranAt: 1000 },
        })
      ).status,
    ).toBe(200);
    const runs = (await call("db_automation_runs_load", { limit: 200 })).body as { taskId: string; status: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ taskId: "a1", status: "success" });

    expect((await call("db_team_runs_load", {})).body).toBeNull();
    expect((await call("db_team_runs_sync", { runs: [{ id: "r1", payload: { plan: [1, 2] } }] })).status).toBe(200);
    expect((await call("db_team_runs_load", {})).body).toEqual([{ id: "r1", payload: { plan: [1, 2] } }]);
  });

  it("LLM 四条：模型清单 / 向量 / 流式聚合 / 转写", async () => {
    const baseUrl = `http://127.0.0.1:${(provider.address() as NodeAddressInfo).port}`;
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    expect((await call("llm_list_models", { baseUrl })).body).toEqual(["a-model", "b-model"]);
    expect((await call("llm_embed", { baseUrl, model: "bge-m3", input: ["a", "b"] })).body).toEqual({
      embeddings: [
        [1, 2, 3],
        [2, 2, 3],
      ],
      dim: 3,
      model: "bge-m3",
    });
    expect((await call("llm_chat_complete", { baseUrl, model: "m", messages: [{ role: "user", content: "hi" }] })).body).toBe("hello");

    const audio = path.join(workspaceDir, "voice.wav");
    writeFileSync(audio, Buffer.from([0x52, 0x49, 0x46, 0x46]));
    expect((await call("llm_transcribe", { baseUrl, model: "whisper-1", path: audio })).body).toEqual({
      text: "transcribed",
    });

    // 未设置的环境变量名必须在发请求前就报错（不许把占位符带出去）。
    const missing = await call("llm_list_models", { baseUrl, apiKeyEnv: "GREYWORK_TEST_UNSET_KEY" });
    expect(missing.status).toBe(400);
    expect((missing.body as { error: string }).error).toContain("未设置 API Key");
  });

  it("llm_chat_start 走事件流，llm_chat_stop 中止", async () => {
    const baseUrl = `http://127.0.0.1:${(provider.address() as NodeAddressInfo).port}`;
    const token = cookie.split("=")[1];
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events?token=${token}`);
    const frames: { event: string; payload: { kind?: string; payload?: { delta?: string; clientToken?: string } } }[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    const started = await call("llm_chat_start", {
      baseUrl,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      clientToken: "turn-1",
    });
    expect(started.status).toBe(200);
    expect(typeof started.body).toBe("number");

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (frames.some((frame) => frame.payload.kind === "llm-done")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const llmFrames = frames.filter((frame) => frame.event === "llm://event");
    const text = llmFrames
      .filter((frame) => frame.payload.kind === "llm-delta")
      .map((frame) => frame.payload.payload?.delta ?? "")
      .join("");
    expect(text).toBe("hello");
    expect(llmFrames.some((frame) => frame.payload.kind === "llm-done")).toBe(true);
    // clientToken 原样回灌（全局广播靠它区分调用方）。
    expect(llmFrames.every((frame) => frame.payload.payload?.clientToken === "turn-1")).toBe(true);

    // 未知 id 的 stop 回 false（与 Rust 的可中止句柄语义一致）。
    expect((await call("llm_chat_stop", { requestId: 9999 })).body).toBe(false);
    socket.close();
  });

  it("worktree_list 只认带标记的快照，worktree_release 只删基目录之下", async () => {
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    const baseDir = path.join(workspaceDir, "worktrees");
    const snapshot = path.join(baseDir, "demo-abc123");
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(path.join(snapshot, "file.txt"), "hello");
    writeFileSync(path.join(snapshot, ".greywork-worktree.json"), JSON.stringify({ kind: "copy", source: workspaceDir }));
    // 没有标记的目录不会被列出。
    mkdirSync(path.join(baseDir, "stray"), { recursive: true });

    const listed = (await call("worktree_list", {})).body as { root: string; kind: string; bytes: number }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ root: snapshot, kind: "copy" });
    // 占用字节含标记文件本身，只断言「统计到了内容」。
    expect(listed[0].bytes).toBeGreaterThanOrEqual(5);

    expect((await call("worktree_release", { root: snapshot })).status).toBe(200);
    expect(existsSync(snapshot)).toBe(false);
    // 目录已不存在：授权面解析失败（400），与 Rust 的 resolve_existing 同口径。
    expect((await call("worktree_release", { root: snapshot })).status).toBe(400);
    // 基目录之外一律拒绝。
    const outside = await call("worktree_release", { root: workspaceDir });
    expect(outside.status).toBe(400);
    expect((outside.body as { error: string }).error).toContain("只允许释放");
  });

  it("rag_status / rag_clear：空索引回零值，清空幂等", async () => {
    const call = async (command: string, args: unknown = {}) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    expect((await call("rag_status")).body).toEqual({ chunks: 0, files: 0, model: null, dim: null });
    expect((await call("rag_clear")).status).toBe(200);
    // 清空后仍是零值（空索引不是错误）。
    expect((await call("rag_status")).body).toEqual({ chunks: 0, files: 0, model: null, dim: null });
  });

  it("skills_install / skills_uninstall：两阶段落盘与卸载", async () => {
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    const files = [
      { path: "SKILL.md", contents: "# demo\n" },
      { path: "scripts/run.sh", contents: "echo hi\n" },
      // 危险路径：绝对路径 / .. / 反斜杠都该被拒。
      { path: "../escape.txt", contents: "x" },
    ];
    const installed = await call("skills_install", {
      workspaceRoot: workspaceDir,
      skillId: "demo-skill",
      files,
    });
    expect(installed.status).toBe(400);
    expect((installed.body as { error: string }).error).toContain("unsafe file path rejected");

    const ok = await call("skills_install", {
      workspaceRoot: workspaceDir,
      skillId: "demo-skill",
      files: files.slice(0, 2),
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { filesWritten: number }).filesWritten).toBe(2);
    expect(readFileSync(path.join(workspaceDir, ".agents", "skills", "demo-skill", "SKILL.md"), "utf8")).toBe("# demo\n");

    expect((await call("skills_uninstall", { workspaceRoot: workspaceDir, skillId: "demo-skill" })).status).toBe(200);
    expect(existsSync(path.join(workspaceDir, ".agents", "skills", "demo-skill"))).toBe(false);

    // 非法 id（大写 / 空格）必须拒绝。
    const badId = await call("skills_uninstall", { workspaceRoot: workspaceDir, skillId: "Bad Id" });
    expect(badId.status).toBe(400);
  });

  it("web_fetch 的 SSRF 防线：环回 / 非法协议在解析阶段就被拒", async () => {
    const call = async (url: string) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command: "web_fetch", args: { url } }),
      });
      return { status: response.status, body: (await response.json()) as { error: string } };
    };
    const loopback = await call("http://127.0.0.1:9/");
    expect(loopback.status).toBe(400);
    expect(loopback.body.error).toBe("web fetch refuses non-public address: 127.0.0.1");

    const ftp = await call("ftp://example.com/file");
    expect(ftp.status).toBe(400);
    expect(ftp.body.error).toContain("only allows http/https");

    const credentials = await call("http://user:pass@example.com/");
    expect(credentials.status).toBe(400);
    expect(credentials.body.error).toContain("embedded credentials");
  });

  it("rag_index_build / rag_search：分块 → 向量化 → 余弦检索", async () => {
    const baseUrl = `http://127.0.0.1:${(provider.address() as NodeAddressInfo).port}`;
    const call = async (command: string, args: unknown = {}) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    const built = await call("rag_index_build", { root: workspaceDir, baseUrl, model: "bge-m3" });
    expect(built.status).toBe(200);
    expect(built.body).toEqual({ files: expect.any(Number), chunks: expect.any(Number), skipped: 0 });

    const hits = (await call("rag_search", { query: "hello parity", baseUrl, model: "bge-m3" })).body as {
      path: string;
      text: string;
      score: number;
    }[];
    expect(hits.length).toBeGreaterThan(0);
    // mock 的向量是位置决定的（多个分块可能同分），只断言「hello.txt 出现在命中里、分数非零」。
    expect(hits.some((hit) => hit.path.includes("hello.txt"))).toBe(true);
    expect(hits[0].score).toBeGreaterThan(0);

    // 清空后索引归零（status 与 clear 的组合契约）。
    expect((await call("rag_clear")).status).toBe(200);
    expect((await call("rag_status")).body).toEqual({ chunks: 0, files: 0, model: null, dim: null });
  });

  it("ACP 全链路：start → new_session → send（权限应答）→ stop", { timeout: 20_000 }, async () => {
    const agentPath = path.resolve(__dirname, "../test-fixtures/mock-agent.mjs");
    const token = cookie.split("=")[1];
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events?token=${token}`);
    const acpEvents: { kind?: string; payload?: Record<string, unknown> }[] = [];
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { event?: string; payload?: { kind?: string } & Record<string, unknown> };
      if (frame.event === "acp://event") acpEvents.push(frame.payload ?? {});
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    const started = await call("acp_start", { agentCmd: `node ${agentPath}`, tier: "workspace" });
    // Rust 的 acp_start 返回裸 handle 数值（不是 {handle} 包装）。
    expect(typeof started.body).toBe("number");
    const handle = started.body as number;

    const created = await call("acp_new_session", { handle, cwd: workspaceDir });
    expect(created.status).toBe(200);
    expect((created.body as { sessionId: string }).sessionId).toBe("sess-1");

    expect((await call("acp_send", { handle, text: "hello" })).status).toBe(200);

    // 等 agent 的权限请求事件，然后应答。
    const deadline = Date.now() + 5000;
    let requestId: number | null = null;
    while (Date.now() < deadline && requestId === null) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const request = acpEvents.find((frame) => frame.kind === "permission-request");
      if (request) requestId = (request.payload as { requestId: number }).requestId;
    }
    expect(requestId).not.toBeNull();
    expect((await call("acp_permission_respond", { requestId, optionId: "allow" })).status).toBe(200);

    // 等 prompt-done（应答权限后 mock 才收尾）。
    const promptDone = await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const frame = acpEvents.find((frame) => frame.kind === "prompt-done");
        if (frame) return frame.payload as { response?: { stopReason?: string } };
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return null;
    })();
    expect(promptDone?.response?.stopReason).toBe("end_turn");
    expect(acpEvents.some((frame) => frame.kind === "session-update" && JSON.stringify(frame.payload).includes("echo back: hello"))).toBe(
      true,
    );

    expect((await call("acp_stop", { handle })).status).toBe(200);
    socket.close();
  });

  it("db_settings：空库回 null，写入后可读回且类型原样", async () => {
    const call = async (command: string, args: unknown = {}) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    const empty = await call("db_settings_load");
    expect(empty.status).toBe(200);
    expect(empty.body).toBeNull();

    const snapshot = { theme: "codex", fontSize: "large", workspaceDir: workspaceDir, nested: { a: [1, 2] } };
    expect((await call("db_settings_sync", { settings: snapshot })).status).toBe(200);

    const loaded = await call("db_settings_load");
    expect(loaded.body).toEqual(snapshot);
  });

  it("未授权路径的读取被拒（400 + 授权提示）", async () => {
    const response = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "fs_list_dir", args: { path: "/" } }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("未获用户授权");
  });

  it("登出清会话与 cookie", async () => {
    const fresh = await login();
    const response = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie: fresh } });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const after = await fetch(`${base}/api/session`, { headers: { cookie: fresh } });
    expect(after.status).toBe(401);
  });

  it("静态托管：入口页 no-cache，assets 一年 immutable，未知路径回落 index", async () => {
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(await index.text()).toContain("greywork-host-node");

    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const fallback = await fetch(`${base}/deep/link`);
    expect(await fallback.text()).toContain("greywork-host-node");
  });

  it("安全响应头随每个响应下发", async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});

describe("终端（PTY）", () => {
  it("打开会话 → 写入命令 → 收到 terminal://data → 关闭", async () => {
    const token = cookie.split("=")[1];
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events?token=${token}`);
    const frames: { event: string; payload: { sessionId?: string; data?: string } }[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const call = async (command: string, args: unknown) => {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      return { status: response.status, body: await response.json() };
    };

    const opened = await call("terminal_open", { shell: undefined, cols: 80, rows: 24 });
    expect(opened.status).toBe(200);
    const sessionId = (opened.body as { sessionId: string }).sessionId;
    expect(sessionId).toMatch(/^term-/);

    expect((await call("terminal_write", { sessionId, data: "echo GREYWORK_PTY\r" })).status).toBe(200);

    const deadline = Date.now() + 5000;
    let text = "";
    while (Date.now() < deadline && !text.includes("GREYWORK_PTY")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const frame of frames) {
        if (frame.event === "terminal://data" && frame.payload.sessionId === sessionId) {
          text += Buffer.from(frame.payload.data ?? "", "base64").toString("utf8");
        }
      }
    }
    expect(text).toContain("GREYWORK_PTY");

    expect((await call("terminal_resize", { sessionId, cols: 100, rows: 40 })).status).toBe(200);
    expect((await call("terminal_close", { sessionId })).status).toBe(200);
    const listed = await call("terminal_list", {});
    expect((listed.body as { sessionId: string }[]).some((item) => item.sessionId === sessionId)).toBe(false);
    socket.close();
  });
});

describe("WebSocket 事件流", () => {
  it("带会话连上后先收到 host://hello", async () => {
    const token = cookie.split("=")[1];
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events?token=${token}`);
    const hello = await new Promise<{ event: string; payload: { version: string } }>((resolve, reject) => {
      socket.once("message", (data) => resolve(JSON.parse(String(data))));
      socket.once("error", reject);
      setTimeout(() => reject(new Error("等待 host://hello 超时")), 3000);
    });
    expect(hello.event).toBe("host://hello");
    expect(typeof hello.payload.version).toBe("string");
    socket.close();
  });

  it("无会话的连接被拒（不升级）", async () => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events`);
    const status = await new Promise<number>((resolve) => {
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", () => resolve(-1));
      setTimeout(() => resolve(0), 3000);
    });
    expect([401, -1]).toContain(status);
  });
});
