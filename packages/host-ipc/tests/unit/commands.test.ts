// 命令目录：只服务服务端态，非服务端态与 HTTP 失败都回 null（fail-open，不误禁）。
// 解析宽进：条目缺字段/类型不对的丢弃，整包不是数组回 null。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshCommands() {
  vi.resetModules();
  return import("../../src/commands");
}

/** 覆盖运行时；不调用则保持未设置（node 环境下 runtimeMode 落 browser-preview）。 */
function stubRuntime(mode: "server" | "desktop"): void {
  vi.stubGlobal("window", { __GREYWORK_RUNTIME__: mode });
}

const ENTRY = {
  name: "fs_list_dir",
  auth: "required",
  desktopOnly: false,
  binary: false,
  available: true,
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadCommandCatalog", () => {
  it("服务端态：GET /api/commands 并原样解析条目", async () => {
    stubRuntime("server");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([ENTRY]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { loadCommandCatalog } = await freshCommands();

    await expect(loadCommandCatalog()).resolves.toEqual([ENTRY]);
    expect(fetchMock).toHaveBeenCalledWith("/api/commands", { credentials: "same-origin" });
  });

  it("桌面态与浏览器预览态：不发请求，回 null", async () => {
    for (const mode of ["desktop", undefined] as const) {
      if (mode) stubRuntime(mode);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { loadCommandCatalog } = await freshCommands();

      await expect(loadCommandCatalog()).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("HTTP 非 2xx：回 null 不抛", async () => {
    stubRuntime("server");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "未认证" }), { status: 401 })),
    );
    const { loadCommandCatalog } = await freshCommands();

    await expect(loadCommandCatalog()).resolves.toBeNull();
  });

  it("网络异常：回 null 不抛", async () => {
    stubRuntime("server");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { loadCommandCatalog } = await freshCommands();

    await expect(loadCommandCatalog()).resolves.toBeNull();
  });

  it("坏条目被丢弃：缺字段 / 类型不对 / 整包不是数组", async () => {
    stubRuntime("server");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              ENTRY,
              { name: "bad1" },
              { name: "bad2", auth: "required", desktopOnly: "yes", binary: false, available: true },
              "junk",
            ]),
            { status: 200 },
          ),
      ),
    );
    const { loadCommandCatalog } = await freshCommands();

    await expect(loadCommandCatalog()).resolves.toEqual([ENTRY]);
  });

  it("整包不是数组：回 null", async () => {
    stubRuntime("server");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 200 })),
    );
    const { loadCommandCatalog } = await freshCommands();

    await expect(loadCommandCatalog()).resolves.toBeNull();
  });
});
