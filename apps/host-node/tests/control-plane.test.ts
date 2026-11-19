/**
 * 控制面接入：注册 / 心跳 / 认领 / 回执全链路，只打本地假控制面与假模型端点。
 *
 * 断言重点是「与 Java 控制面记录的契约」：PUT 注册体、认领条数、finish 的
 * status/detail/output 字段，以及无人值守执行的三条边界（ACP 任务拒绝、无供应商、
 * 401 时的可操作提示）。
 */
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlaneError, ControlPlaneRuntime } from "../src/control-plane.js";
import { Db } from "../src/db.js";

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>);
}

interface Fake {
  origin: string;
  calls: Recorded[];
  close: () => Promise<void>;
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Fake> {
  const calls: Recorded[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      calls.push({ method: request.method ?? "GET", path: request.url ?? "/", body });
      handler(request, response);
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: "http://127.0.0.1:" + String(port),
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** 一条到期任务（camelCase，与 Java 的 DueView 对齐）。 */
function due(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    taskId: "task-1",
    name: "每日简报",
    target: "demo",
    intent: "写一句问候",
    acpProviderId: null,
    model: null,
    dueAt: "2026-11-16T09:00:00",
    ...overrides,
  };
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) {
    const close = cleanups.pop();
    if (close) await close();
  }
});

async function fakeControlPlane(dues: Record<string, unknown>[], heartbeatStatus = 204): Promise<Fake> {
  const fake = await listen((request, response) => {
    const url = request.url ?? "";
    if (request.method === "PUT" && url === "/api/hosts/me") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ deviceId: 7, alive: true }));
      return;
    }
    if (request.method === "POST" && url === "/api/hosts/me/heartbeat") {
      if (heartbeatStatus !== 204) {
        response
          .writeHead(heartbeatStatus, { "content-type": "application/json" })
          .end(JSON.stringify({ code: "unauthorized", message: "未认证" }));
        return;
      }
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && url === "/api/hosts/me/automation/claim") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(dues));
      return;
    }
    if (request.method === "POST" && url.startsWith("/api/hosts/me/automation/due/") && url.endsWith("/finish")) {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  cleanups.push(fake.close);
  return fake;
}

async function fakeModel(reply: string): Promise<Fake> {
  const fake = await listen((request, response) => {
    if (request.method === "POST" && (request.url ?? "").endsWith("/chat/completions")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      return;
    }
    response.writeHead(404).end();
  });
  cleanups.push(fake.close);
  return fake;
}

function runtimeWith(db: Db, dataDir: string, tickSecs = 3600): ControlPlaneRuntime {
  const runtime = new ControlPlaneRuntime({ dataDir, version: "9.9.9", db, tickSecs, timeoutSecs: 10 });
  cleanups.push(async () => runtime.stop());
  return runtime;
}

describe("control plane", () => {
  const identity = {
    user: { id: "9223372036854775806", email: "u@grey.local", displayName: "Jean", role: "USER" },
    device: { id: 7, name: "工作电脑", platform: "desktop" },
  };

  async function accountServer(meStatus = 200, logoutStatus = 204): Promise<Fake> {
    const server = await listen((request, response) => {
      expect(request.headers.authorization).toBe("Bearer tok-account");
      if (request.url === "/api/auth/me") {
        response
          .writeHead(meStatus, { "content-type": "application/json" })
          .end(
            JSON.stringify(meStatus === 200 ? { ...identity, token: "must-not-leak" } : { code: "session_stale", message: "登录态已失效" }),
          );
        return;
      }
      if (request.url === "/api/auth/logout") {
        response.writeHead(logoutStatus).end();
        return;
      }
      response.writeHead(204).end();
    });
    cleanups.push(server.close);
    return server;
  }

  function accountRuntime(): { runtime: ControlPlaneRuntime; dataDir: string; db: Db } {
    const dataDir = mkdtempSync(path.join(tmpdir(), "gw-account-"));
    const db = new Db(path.join(dataDir, "greywork.db"));
    cleanups.push(async () => db.close());
    return { runtime: runtimeWith(db, dataDir), dataDir, db };
  }

  it("账号从 Java 核验，重启后可恢复身份，Long ID 与凭据隔离", async () => {
    const control = await accountServer();
    const { runtime, dataDir, db } = accountRuntime();
    expect((await runtime.account()).session).toBeNull();
    await runtime.configure({ baseUrl: control.origin, token: "tok-account" });
    const account = await runtime.account();
    expect(account.session).toEqual(identity);
    expect(JSON.stringify(account)).not.toMatch(/tok-account|must-not-leak/);
    runtime.stop();
    const restored = runtimeWith(db, dataDir);
    expect((await restored.account()).session?.user.id).toBe(identity.user.id);
    expect(control.calls.some((call) => call.method === "GET" && call.path === "/api/auth/me")).toBe(true);
  });

  it("账号被吊销时不展示旧身份，并停止心跳", async () => {
    const control = await accountServer(401);
    const { runtime } = accountRuntime();
    await runtime.configure({ baseUrl: control.origin, token: "tok-account" });
    const account = await runtime.account();
    expect(account.session).toBeNull();
    expect(account.error).toContain("登录态失效");
    expect(account.status).toMatchObject({ configured: true, registered: false });
  });

  it("资料、设备和会话操作按 Java 契约转发，超长 ID 不截断且不泄漏额外字段", async () => {
    const id = "9223372036854775805";
    let name = "Jean";
    let revoked = false;
    const control = await listen((request, response) => {
      expect(request.headers.authorization).toBe("Bearer tok-account");
      if (request.url === "/api/auth/me" && request.method === "PATCH") {
        name = "新昵称";
        response.writeHead(200).end("{}");
      } else if (request.url === "/api/auth/me") {
        response.writeHead(200).end(JSON.stringify({ ...identity, user: { ...identity.user, displayName: name } }));
      } else if (request.url === "/api/devices") {
        response.writeHead(200).end(
          JSON.stringify(
            revoked
              ? []
              : [
                  {
                    id,
                    name: "手机",
                    platform: "phone",
                    current: false,
                    lastSeenAt: "2026-11-18T10:00:00",
                    createdAt: null,
                    token: "secret-must-not-leak",
                  },
                ],
          ),
        );
      } else {
        if (request.url === `/api/devices/${id}`) revoked = true;
        response.writeHead(204).end();
      }
    });
    cleanups.push(control.close);
    const { runtime } = accountRuntime();
    await runtime.configure({ baseUrl: control.origin, token: "tok-account" });
    const list = await runtime.manageAccount("devices");
    expect(list.devices?.[0]?.id).toBe(id);
    expect(JSON.stringify(list)).not.toMatch(/tok-account|secret-must-not-leak/);
    expect((await runtime.manageAccount("profile", " 新昵称 ")).session?.user.displayName).toBe("新昵称");
    expect(control.calls.find((call) => call.method === "PATCH")?.body).toEqual({ displayName: "新昵称" });
    await runtime.manageAccount("revokeOthers");
    expect(control.calls.some((call) => call.method === "DELETE" && call.path === "/api/auth/sessions?includeCurrent=false")).toBe(true);
    expect((await runtime.manageAccount("revokeDevice", id)).devices).toEqual([]);
    expect(control.calls.some((call) => call.method === "DELETE" && call.path === `/api/devices/${id}`)).toBe(true);
    expect((await runtime.manageAccount("revokeDevice", "7")).error).toContain("当前设备");
    expect((await runtime.manageAccount("revokeDevice", "007")).error).toContain("ID 无效");
    expect((await runtime.manageAccount("revokeDevice", "../auth/logout")).error).toContain("ID 无效");
    expect((await runtime.manageAccount("profile", " ")).error).toContain("显示名称");
    expect(control.calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  });

  it("设备加载失败可重试，401 清空身份并停止运行时", async () => {
    let status = 503;
    const control = await listen((request, response) => {
      if (request.url === "/api/auth/me") response.writeHead(200).end(JSON.stringify(identity));
      else if (request.url === "/api/devices") response.writeHead(status).end('{"message":"暂不可用"}');
      else response.writeHead(204).end();
    });
    cleanups.push(control.close);
    const { runtime } = accountRuntime();
    await runtime.configure({ baseUrl: control.origin, token: "tok-account" });
    expect(await runtime.manageAccount("devices")).toMatchObject({ session: identity, error: expect.stringContaining("503") });
    status = 401;
    expect(await runtime.manageAccount("devices")).toMatchObject({ session: null, status: { registered: false } });
  });

  it("环境管理拒绝资料和设备修改，也拒绝退出其他设备", async () => {
    const control = await accountServer();
    vi.stubEnv("GREYWORK_CONTROL_URL", control.origin);
    vi.stubEnv("GREYWORK_CONTROL_TOKEN", "tok-account");
    const { runtime } = accountRuntime();
    for (const action of ["profile", "revokeDevice", "revokeOthers"] as const) {
      await expect(runtime.manageAccount(action, "7")).rejects.toThrow("环境变量");
    }
    expect(control.calls).toHaveLength(0);
  });

  it("退出先撤销 Java 会话，再清除本机配置", async () => {
    const control = await accountServer();
    const { runtime, dataDir } = accountRuntime();
    await runtime.configure({ baseUrl: control.origin, token: "tok-account" });
    expect(await runtime.logout()).toMatchObject({ configured: false, registered: false });
    expect(control.calls.some((call) => call.method === "POST" && call.path === "/api/auth/logout")).toBe(true);
    expect(existsSync(path.join(dataDir, "control-plane.json"))).toBe(false);
    expect((await runtime.account()).session).toBeNull();
  });

  it("退出失败保留凭据供重试，已失效的会话允许清理", async () => {
    const failed = await accountServer(200, 503);
    const { runtime, dataDir } = accountRuntime();
    await runtime.configure({ baseUrl: failed.origin, token: "tok-account" });
    await expect(runtime.logout()).rejects.toThrow("503");
    expect(existsSync(path.join(dataDir, "control-plane.json"))).toBe(true);
    const expired = await accountServer(401, 401);
    await runtime.configure({ baseUrl: expired.origin, token: "tok-account" });
    expect((await runtime.logout()).configured).toBe(false);
  });

  it("环境变量管理的账号只能查看，不能从界面撤销", async () => {
    const control = await accountServer();
    vi.stubEnv("GREYWORK_CONTROL_URL", control.origin);
    vi.stubEnv("GREYWORK_CONTROL_TOKEN", "tok-account");
    const { runtime } = accountRuntime();
    expect((await runtime.account()).session).toEqual(identity);
    await expect(runtime.logout()).rejects.toThrow("环境变量");
    expect(control.calls.some((call) => call.path === "/api/auth/logout")).toBe(false);
  });

  it("接入 → 注册 → 心跳 → 认领 → 模型直连 → 回执", async () => {
    const control = await fakeControlPlane([due()]);
    const model = await fakeModel("云端问候：早上好");
    const dataDir = mkdtempSync(path.join(tmpdir(), "gw-cp-"));
    const db = new Db(path.join(dataDir, "greywork.db"));
    db.syncSettings({
      modelProviders: [
        { id: "p1", name: "本地", kind: "openai-compatible", baseUrl: model.origin + "/", model: "m1", apiKeyEnv: "", enabled: true },
      ],
      selectedModelProviderId: "p1",
    });
    const runtime = runtimeWith(db, dataDir);

    expect(runtime.status().configured).toBe(false);

    const status = await runtime.configure({ baseUrl: control.origin + "/", token: "tok-1" });
    expect(status).toMatchObject({ configured: true, source: "file", registered: true, baseUrl: control.origin });
    expect(status.lastError).toBeNull();

    // 凭据落盘 0600，且不回显 token
    const file = path.join(dataDir, "control-plane.json");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(status)).not.toContain("tok-1");

    const register = control.calls.find((call) => call.method === "PUT" && call.path === "/api/hosts/me");
    expect(register?.body).toMatchObject({ name: "greywork-host", version: "9.9.9", capabilities: [] });

    const { outcomes } = await runtime.runOnce();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ name: "每日简报", ok: true, output: "云端问候：早上好" });

    const claim = control.calls.find((call) => call.path === "/api/hosts/me/automation/claim");
    expect(claim?.body).toEqual({ limit: 1 });
    const finish = control.calls.find((call) => call.path === "/api/hosts/me/automation/due/101/finish");
    expect(finish?.body).toMatchObject({ status: "ok", output: "云端问候：早上好" });
    expect(String(finish?.body?.detail)).toContain("云端问候");

    const sent = model.calls.find((call) => call.path.endsWith("/v1/chat/completions"));
    expect(sent?.body).toMatchObject({ model: "m1", stream: false, messages: [{ role: "user", content: "写一句问候" }] });
    expect(runtime.status().lastOutcome).toMatchObject({ name: "每日简报", ok: true });
  });

  it("绑定 ACP 的任务直接回执失败，不去调模型", async () => {
    const control = await fakeControlPlane([due({ acpProviderId: "codebuddy", name: "带工具的任务" })]);
    const dataDir = mkdtempSync(path.join(tmpdir(), "gw-cp-"));
    const db = new Db(path.join(dataDir, "greywork.db"));
    const runtime = runtimeWith(db, dataDir);
    await runtime.configure({ baseUrl: control.origin, token: "tok-2" });

    const { outcomes, status } = await runtime.runOnce();
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toContain("ACP");
    const finish = control.calls.find((call) => call.path.endsWith("/finish"));
    expect(finish?.body).toMatchObject({ status: "failed" });
    expect(status.registered).toBe(true);
  });

  it("入场码换 token：成功后 token 落盘，401 给出可操作提示", async () => {
    const control = await listen((request, response) => {
      if (request.method === "POST" && request.url === "/api/auth/enroll") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ token: "tok-enroll", user: { id: 1, email: "u@grey.local" }, device: { id: 7, name: "pc" } }));
        return;
      }
      if (request.method === "PUT" && request.url === "/api/hosts/me") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ deviceId: 7, alive: true }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/hosts/me/heartbeat") {
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ code: "unauthorized" }));
        return;
      }
      response.writeHead(404).end();
    });
    cleanups.push(control.close);
    const dataDir = mkdtempSync(path.join(tmpdir(), "gw-cp-"));
    const db = new Db(path.join(dataDir, "greywork.db"));
    const runtime = runtimeWith(db, dataDir);

    const status = await runtime.configure({
      baseUrl: control.origin,
      email: "u@grey.local",
      code: "ABC123",
      displayName: "Jean",
      deviceName: "工作电脑",
    });
    const enroll = control.calls.find((call) => call.path === "/api/auth/enroll");
    expect(enroll?.body).toMatchObject({
      code: "ABC123",
      email: "u@grey.local",
      platform: "desktop",
      displayName: "Jean",
      deviceName: "工作电脑",
    });
    // 心跳 401：配置保留、错误可见、registered 回到 false
    expect(status.configured).toBe(true);
    expect(status.registered).toBe(false);
    expect(status.lastError).toContain("401");
    expect(status.email).toBe("u@grey.local");
  });

  it("入场码被拒时抛出 ControlPlaneError 且不落盘", async () => {
    const control = await listen((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ code: "invalid_code", message: "入场码无效" }));
    });
    cleanups.push(control.close);
    const dataDir = mkdtempSync(path.join(tmpdir(), "gw-cp-"));
    const db = new Db(path.join(dataDir, "greywork.db"));
    const runtime = runtimeWith(db, dataDir);

    await expect(runtime.configure({ baseUrl: control.origin, email: "u@grey.local", code: "bad" })).rejects.toBeInstanceOf(
      ControlPlaneError,
    );
    expect(existsSync(path.join(dataDir, "control-plane.json"))).toBe(false);
    expect(runtime.status().configured).toBe(false);
  });

  it("没配模型供应商时回执失败而不是崩掉认领链", async () => {
    const control = await fakeControlPlane([due()]);
    const dataDir = mkdtempSync(path.join(tmpdir(), "gw-cp-"));
    const db = new Db(path.join(dataDir, "greywork.db"));
    const runtime = runtimeWith(db, dataDir);
    await runtime.configure({ baseUrl: control.origin, token: "tok-3" });

    const { outcomes } = await runtime.runOnce();
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].detail).toContain("模型供应商");
    expect(control.calls.some((call) => call.path.endsWith("/finish") && call.body?.status === "failed")).toBe(true);
  });

  it("断开清掉配置：状态回到未配置，文件删除", async () => {
    const control = await fakeControlPlane([]);
    const dataDir = mkdtempSync(path.join(tmpdir(), "gw-cp-"));
    const db = new Db(path.join(dataDir, "greywork.db"));
    const runtime = runtimeWith(db, dataDir);
    await runtime.configure({ baseUrl: control.origin, token: "tok-4" });
    expect(existsSync(path.join(dataDir, "control-plane.json"))).toBe(true);

    const status = runtime.clear();
    expect(status).toMatchObject({ configured: false, registered: false, source: null });
    expect(existsSync(path.join(dataDir, "control-plane.json"))).toBe(false);
  });

  it("非法地址在保存前就被拒", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "gw-cp-"));
    const db = new Db(path.join(dataDir, "greywork.db"));
    const runtime = runtimeWith(db, dataDir);
    await expect(runtime.configure({ baseUrl: "192.168.1.10:8080", token: "t" })).rejects.toThrow(/URL/);
    await expect(runtime.configure({ baseUrl: "ftp://x.test", token: "t" })).rejects.toThrow(/http/);
  });
});
