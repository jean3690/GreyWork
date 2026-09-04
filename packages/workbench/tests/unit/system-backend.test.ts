/**
 * system-backend 双态测试：桌面 invoke sys_info；浏览器态 null。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked((await import("@tauri-apps/api/core")).invoke);

import { systemBackend } from "@/lib/system-backend";

describe("system-backend 双态", () => {
  const storageHolder = globalThis as { localStorage?: Storage };

  function installLocalStorage(): void {
    const store = new Map<string, string>();
    storageHolder.localStorage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key) => store.get(key) ?? null,
      key: (index) => [...store.keys()][index] ?? null,
      removeItem: (key) => void store.delete(key),
      setItem: (key, value) => void store.set(key, String(value)),
    };
  }

  beforeEach(() => {
    installLocalStorage();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete storageHolder.localStorage;
  });

  it("桌面态：invoke sys_info 返回快照（camelCase 字段）", async () => {
    const snapshot = {
      version: "0.1.0",
      schemaVersion: 5,
      logDir: "/home/test/.local/share/greywork/logs",
      activeAgents: 2,
      os: "linux",
    };
    invokeMock.mockResolvedValue(snapshot);

    expect(systemBackend.active()).toBe(true);
    await expect(systemBackend.info()).resolves.toEqual(snapshot);
    expect(invokeMock).toHaveBeenCalledWith("sys_info");
  });

  it("桌面态拉取失败：错误向上抛（由 UI 捕获降级展示）", async () => {
    invokeMock.mockRejectedValue(new Error("IPC 断开"));
    await expect(systemBackend.info()).rejects.toThrow("IPC 断开");
  });

  it("浏览器态：无宿主 → info 返回 null", async () => {
    vi.stubGlobal("window", {});
    expect(systemBackend.active()).toBe(false);
    await expect(systemBackend.info()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
