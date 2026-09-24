import { afterEach, describe, expect, it, vi } from "vitest";

async function freshSession() {
  vi.resetModules();
  return import("../../src/session");
}

function errorResponse(status: number, body: string, contentType = "application/json"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasSession", () => {
  it("200 → true", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authenticated: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { hasSession } = await freshSession();

    await expect(hasSession()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/session", { credentials: "same-origin" });
  });

  it("401 → false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(401, JSON.stringify({ error: "未认证" }))),
    );
    const { hasSession } = await freshSession();

    await expect(hasSession()).resolves.toBe(false);
  });

  it("网络异常 → false（入口按未登录处理）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { hasSession } = await freshSession();

    await expect(hasSession()).resolves.toBe(false);
  });
});

describe("login", () => {
  it("成功时 POST /api/login 并 resolve", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: "t" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { login } = await freshSession();

    await expect(login("hunter2")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
  });

  it("401 抛服务端文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(401, JSON.stringify({ error: "未认证" }))),
    );
    const { login } = await freshSession();

    await expect(login("wrong")).rejects.toThrow("未认证");
  });

  it("429 抛限流文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(429, JSON.stringify({ error: "登录尝试过于频繁，请稍后再试" }))),
    );
    const { login } = await freshSession();

    await expect(login("wrong")).rejects.toThrow("登录尝试过于频繁，请稍后再试");
  });

  it("错误体非 JSON 时退回兜底文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(500, "boom", "text/plain")),
    );
    const { login } = await freshSession();

    await expect(login("x")).rejects.toThrow("登录失败（HTTP 500）");
  });
});

describe("onAuthRequired / notifyAuthRequired", () => {
  it("通知所有订阅者；解绑后不再收到", async () => {
    const { onAuthRequired, notifyAuthRequired } = await freshSession();

    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = onAuthRequired(first);
    onAuthRequired(second);

    notifyAuthRequired();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    notifyAuthRequired();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("单个订阅者抛错不影响其余订阅者", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { onAuthRequired, notifyAuthRequired } = await freshSession();

    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    onAuthRequired(bad);
    onAuthRequired(good);

    notifyAuthRequired();

    expect(good).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
