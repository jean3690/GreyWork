import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GreyworkCore from "@greywork/core";

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn<() => boolean>(() => false),
  tauriInvoke: vi.fn(),
}));

vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyworkCore>()),
  isTauriRuntime: mocks.isTauriRuntime,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.tauriInvoke }));

const OVERRIDE_KEY = "__GREYWORK_RUNTIME__";

async function freshBarrel() {
  vi.resetModules();
  return import("../../src/index");
}

function stubWindow(override?: string): void {
  vi.stubGlobal("window", override === undefined ? {} : { [OVERRIDE_KEY]: override });
}

/** 构造一个服务端错误响应。 */
function errorResponse(status: number, body: string, contentType = "application/json"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

beforeEach(() => {
  mocks.isTauriRuntime.mockReturnValue(false);
  mocks.tauriInvoke.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("invoke —— desktop", () => {
  it("直通 Tauri invoke，不做任何加工，且保持实参个数", async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.tauriInvoke.mockResolvedValue({ foo: "bar" });
    stubWindow();
    const { invoke } = await freshBarrel();

    await expect(invoke("db_settings_load")).resolves.toEqual({ foo: "bar" });
    // 无参调用不补 undefined：调用点用 toHaveBeenCalledWith("cmd") 断言，多一个实参会失配。
    expect(mocks.tauriInvoke).toHaveBeenCalledWith("db_settings_load");

    await invoke("worktree_list", { workspaceId: "w1" });
    expect(mocks.tauriInvoke).toHaveBeenLastCalledWith("worktree_list", { workspaceId: "w1" });
  });
});

describe("invoke —— server", () => {
  it("POST /api/command，args 原样透传（camelCase 不做键改写）", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    stubWindow("server");
    const { invoke } = await freshBarrel();

    await expect(invoke("fs_read_text_file", { workspaceRoot: "/w", path: "a.txt" })).resolves.toEqual({ a: 1 });
    expect(fetchMock).toHaveBeenCalledWith("/api/command", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "fs_read_text_file", args: { workspaceRoot: "/w", path: "a.txt" } }),
    });
  });

  it("无参命令的 args 序列化为 null", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(null), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    stubWindow("server");
    const { invoke } = await freshBarrel();

    await invoke("acp_list");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/command",
      expect.objectContaining({ body: JSON.stringify({ command: "acp_list", args: null }) }),
    );
  });

  it("x-greywork-binary 头 → 返回 ArrayBuffer", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes, { status: 200, headers: { "x-greywork-binary": "1" } })),
    );
    stubWindow("server");
    const { invoke } = await freshBarrel();

    const result = await invoke<ArrayBuffer>("fs_read_binary", { path: "/a.bin" });
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(result)]).toEqual([1, 2, 3]);
  });

  it("octet-stream content-type（无自定义头）同样按二进制处理", async () => {
    const bytes = new Uint8Array([9, 8]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } })),
    );
    stubWindow("server");
    const { invoke } = await freshBarrel();

    const result = await invoke<ArrayBuffer>("channel_take_media", { channel: "wechat", path: "/m" });
    expect([...new Uint8Array(result)]).toEqual([9, 8]);
  });

  it("响应完全没有 content-type 时按 JSON 处理", async () => {
    // 用最小替身而不是 new Response：undici 会给字符串体自动补 content-type，构造不出「无该头」。
    const headerless = { ok: true, headers: { get: () => null }, json: async () => ({ a: 1 }) } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => headerless),
    );
    stubWindow("server");
    const { invoke } = await freshBarrel();

    await expect(invoke("db_settings_load")).resolves.toEqual({ a: 1 });
  });
});

describe("invoke —— 错误映射", () => {
  it("401 抛 HostAuthError 并触发 onAuthRequired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(401, JSON.stringify({ error: "未认证" }))),
    );
    stubWindow("server");
    const { invoke, HostAuthError, onAuthRequired } = await freshBarrel();

    const handler = vi.fn();
    onAuthRequired(handler);

    const rejection = await invoke("db_settings_load").catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(HostAuthError);
    expect((rejection as Error).message).toBe("未认证");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("403 抛普通 Error、带服务端文案，且不触发重弹", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(403, JSON.stringify({ error: "命令 sys_info 仅桌面端可用" }))),
    );
    stubWindow("server");
    const { invoke, HostAuthError, onAuthRequired } = await freshBarrel();

    const handler = vi.fn();
    onAuthRequired(handler);

    const rejection = await invoke("sys_info").catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(HostAuthError);
    expect((rejection as Error).message).toBe("命令 sys_info 仅桌面端可用");
    expect(handler).not.toHaveBeenCalled();
  });

  it("404 与 429 同样走普通 Error", async () => {
    stubWindow("server");
    const { invoke } = await freshBarrel();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(404, JSON.stringify({ error: "未知命令: nope" }))),
    );
    await expect(invoke("nope")).rejects.toThrow("未知命令: nope");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(429, JSON.stringify({ error: "登录尝试过于频繁，请稍后再试" }))),
    );
    await expect(invoke("db_settings_load")).rejects.toThrow("登录尝试过于频繁，请稍后再试");
  });

  it("错误体不是 JSON（网关错误页）时退回兜底文案，不吞掉状态码", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(502, "<html>502 Bad Gateway</html>", "text/html")),
    );
    stubWindow("server");
    const { invoke } = await freshBarrel();

    await expect(invoke("db_settings_load")).rejects.toThrow("命令 db_settings_load 失败（HTTP 502）");
  });
});

describe("invoke —— browser-preview", () => {
  it("抛 HostUnavailableError 且不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stubWindow();
    const { invoke, HostUnavailableError } = await freshBarrel();

    await expect(invoke("db_settings_load")).rejects.toBeInstanceOf(HostUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
