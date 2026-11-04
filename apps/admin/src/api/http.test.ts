import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, http } from "./http";
import { clearSession, readToken, writeSession } from "./session";

const admin = { id: 1, email: "admin@grey.local", displayName: "Admin", role: "admin" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("http", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("有 token 时带 Authorization，并解析 JSON", async () => {
    writeSession("tok-1", admin);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await http.get<{ ok: boolean }>("/api/admin/overview");

    expect(result).toEqual({ ok: true });
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok-1");
  });

  it("POST 自动带 JSON Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: "x" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await http.post("/api/admin/auth/login", { email: "a", password: "b" });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ email: "a", password: "b" }));
  });

  it("204 返回 undefined", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(http.delete("/api/admin/enroll-codes/1")).resolves.toBeUndefined();
  });

  it("401 清会话并广播事件，错误体映射成 ApiError", async () => {
    writeSession("tok-1", admin);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: "admin_login_invalid", message: "邮箱或密码不正确" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    window.addEventListener("grey:admin-unauthorized", onUnauthorized);

    const failure = http.post("/api/admin/auth/login", { email: "a", password: "b" });

    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({
      status: 401,
      code: "admin_login_invalid",
      message: "邮箱或密码不正确",
    });
    expect(readToken()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    window.removeEventListener("grey:admin-unauthorized", onUnauthorized);
  });

  it("连不上后端时给出可读错误", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(http.get("/api/admin/overview")).rejects.toMatchObject({
      status: 0,
      code: "network_error",
    });
  });

  it("clearSession 之后不再带 Authorization", async () => {
    writeSession("tok-1", admin);
    clearSession();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await http.get("/api/admin/overview");

    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
  });
});
