/**
 * 登录门判定（features/auth/gate）：只有服务端态需要登录，且以 /api/session 的应答为准。
 *
 * 桌面态与浏览器预览态都必须在**不查会话**的前提下短路返回 false —— 前者没有会话概念，
 * 后者没有宿主，多打一次 /api/session 只会白白拖慢启动。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runtimeMode: vi.fn<() => "desktop" | "server" | "browser-preview">(() => "desktop"),
  hasSession: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("@greywork/host-ipc", () => ({
  runtimeMode: h.runtimeMode,
  hasSession: h.hasSession,
}));

import { needsLogin } from "@/features/auth/gate";

beforeEach(() => {
  h.runtimeMode.mockReset().mockReturnValue("desktop");
  h.hasSession.mockReset();
});

describe("needsLogin", () => {
  it("桌面态不需要登录，且不查会话", async () => {
    await expect(needsLogin()).resolves.toBe(false);
    expect(h.hasSession).not.toHaveBeenCalled();
  });

  it("浏览器预览态不需要登录，且不查会话", async () => {
    h.runtimeMode.mockReturnValue("browser-preview");

    await expect(needsLogin()).resolves.toBe(false);
    expect(h.hasSession).not.toHaveBeenCalled();
  });

  it("服务端态且没有有效会话 → 需要登录", async () => {
    h.runtimeMode.mockReturnValue("server");
    h.hasSession.mockResolvedValue(false);

    await expect(needsLogin()).resolves.toBe(true);
    expect(h.hasSession).toHaveBeenCalledTimes(1);
  });

  it("服务端态且会话有效 → 放行", async () => {
    h.runtimeMode.mockReturnValue("server");
    h.hasSession.mockResolvedValue(true);

    await expect(needsLogin()).resolves.toBe(false);
  });
});
