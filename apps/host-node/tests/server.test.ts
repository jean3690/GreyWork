import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { LoginThrottle, SessionStore, passwordChecker } from "../src/auth.js";
import { Db } from "../src/db.js";
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
});

const sessions = new SessionStore(passwordChecker(config), config.sessionTtlSecs);
const throttle = new LoginThrottle();
const access = new WorkspaceAccess(workspaceDir, path.join(dataDir, "workspace-path-access.json"));
for (const root of config.workspaceRoots) access.authorizeSelectedPath(root);
const db = new Db(path.join(dataDir, "greywork.db"));

const { server, close } = createHostServer({
  config,
  sessions,
  throttle,
  staticRoot: resolveStaticRoot(config.staticDir),
  access,
  db,
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = await login();
});

afterAll(async () => {
  await close();
  db.close();
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
    expect(list.find((item) => item.name === "git_status")?.available).toBe(false);
    // 可信宿主专属命令在普通部署里也不可用（与 policy.rs 的 TRUSTED_HOST_ONLY 同名单）。
    expect(list.find((item) => item.name === "terminal_shells")?.available).toBe(false);
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
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain("未知命令");

    const desktop = await call("reveal_path");
    expect(desktop.status).toBe(403);

    const unmigrated = await call("git_status");
    expect(unmigrated.status).toBe(501);
    expect(unmigrated.body.error).toContain("尚未迁移");

    const untrusted = await call("terminal_shells");
    expect(untrusted.status).toBe(403);
    expect(untrusted.body.error).toContain("可信宿主");
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
