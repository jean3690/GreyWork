import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GreyworkCore from "@greywork/core";

const mocks = vi.hoisted(() => ({ isTauriRuntime: vi.fn<() => boolean>(() => false) }));

// 门面用包导入读 isTauriRuntime，所以 mock 包导出即可（ESM live binding 在调用时生效）。
vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyworkCore>()),
  isTauriRuntime: mocks.isTauriRuntime,
}));

const OVERRIDE_KEY = "__GREYWORK_RUNTIME__";

/** 每个用例拿一份全新模块：探测结果缓存在 runtime.ts 的模块作用域，跨用例会串。 */
async function freshRuntime() {
  vi.resetModules();
  return import("../../src/runtime");
}

/** 装一个最小 window，可选写入显式覆盖键。 */
function stubWindow(override?: string): void {
  vi.stubGlobal("window", override === undefined ? {} : { [OVERRIDE_KEY]: override });
}

beforeEach(() => {
  mocks.isTauriRuntime.mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtimeMode", () => {
  it("渲染端有 Tauri 注入时判定为 desktop", async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    stubWindow();
    const { runtimeMode } = await freshRuntime();
    expect(runtimeMode()).toBe("desktop");
  });

  it("判定是实时的：mock 翻转后立刻改变", async () => {
    stubWindow();
    const { runtimeMode } = await freshRuntime();
    expect(runtimeMode()).toBe("browser-preview");
    mocks.isTauriRuntime.mockReturnValue(true);
    expect(runtimeMode()).toBe("desktop");
  });

  it("显式覆盖优先于桌面端判定", async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    stubWindow("server");
    const { runtimeMode } = await freshRuntime();
    expect(runtimeMode()).toBe("server");
  });

  it("非法覆盖值被忽略", async () => {
    stubWindow("nonsense");
    const { runtimeMode } = await freshRuntime();
    expect(runtimeMode()).toBe("browser-preview");
  });

  it("没有 window（非浏览器环境）退回 browser-preview", async () => {
    const { runtimeMode } = await freshRuntime();
    expect(runtimeMode()).toBe("browser-preview");
  });
});

describe("hasHostCommands", () => {
  it("只在 browser-preview 为 false", async () => {
    stubWindow();
    const { hasHostCommands } = await freshRuntime();
    expect(hasHostCommands()).toBe(false);
    mocks.isTauriRuntime.mockReturnValue(true);
    expect(hasHostCommands()).toBe(true);
  });
});

describe("initRuntimeMode", () => {
  it("探测 /api/health 成功判定为 server", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    stubWindow();
    const { initRuntimeMode, runtimeMode } = await freshRuntime();
    await expect(initRuntimeMode()).resolves.toBe("server");
    expect(runtimeMode()).toBe("server");
    expect(fetchMock).toHaveBeenCalledWith("/api/health", { credentials: "same-origin" });
  });

  it("探测非 2xx 判定为 browser-preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    stubWindow();
    const { initRuntimeMode } = await freshRuntime();
    await expect(initRuntimeMode()).resolves.toBe("browser-preview");
  });

  it("探测抛错（离线）判定为 browser-preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    stubWindow();
    const { initRuntimeMode } = await freshRuntime();
    await expect(initRuntimeMode()).resolves.toBe("browser-preview");
  });

  it("桌面端初始化零 I/O", async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stubWindow();
    const { initRuntimeMode } = await freshRuntime();
    await expect(initRuntimeMode()).resolves.toBe("desktop");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("显式覆盖时不探测", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stubWindow("server");
    const { initRuntimeMode } = await freshRuntime();
    await expect(initRuntimeMode()).resolves.toBe("server");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HostUnavailableError", () => {
  it("错误信息带上被拒绝的能力名", async () => {
    const { HostUnavailableError } = await freshRuntime();
    const error = new HostUnavailableError("命令 fs_read_binary");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("HostUnavailableError");
    expect(error.message).toContain("fs_read_binary");
    expect(error.message).toContain("浏览器预览");
  });
});
