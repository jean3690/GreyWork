/**
 * system-backend 双态测试：桌面 invoke sys_info；浏览器态 null。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: vi.fn(),
}));
const invokeMock = vi.mocked((await import("@greywork/host-ipc")).invoke);

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
    vi.stubGlobal("window", { __GREYWORK_RUNTIME__: "server" });
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
      trayAvailable: true,
      totalMemoryBytes: 16 * 1024 ** 3,
      cpuCount: 8,
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

  it("托盘可用性以壳的自答为准（快照与壳不一致时取壳的答案）", async () => {
    // Electron 形态就是这个形状：快照由 sidecar 回答（它没有托盘，恒 false），
    // 而托盘真实可用性只有壳知道 —— 照抄快照会让设置页说「托盘不可用」。
    const snapshot = {
      version: "0.1.0",
      schemaVersion: 5,
      logDir: null,
      activeAgents: 0,
      os: "linux",
      trayAvailable: false,
      totalMemoryBytes: null,
      cpuCount: 8,
    };
    let calls = 0;
    invokeMock.mockImplementation(() => Promise.resolve(++calls === 1 ? snapshot : { trayAvailable: true }));
    // 有原生壳时 info() 改问壳的自答（bridge.tray.available），这里给一个真 bridge。
    vi.stubGlobal("window", {
      __GREYWORK_RUNTIME__: "server",
      __GREYWORK_SHELL__: {
        window: {},
        tray: {
          available: () => Promise.resolve(true),
          setCloseToTray: vi.fn(),
          setLabels: vi.fn(),
          onNewChat: vi.fn(),
          onOpenSettings: vi.fn(),
        },
      },
    });

    const info = await systemBackend.info();
    expect(info?.trayAvailable).toBe(true);
    expect(info?.version).toBe("0.1.0");
  });

  it("问不到壳的托盘可用性时沿用快照，不误判为不可用", async () => {
    const snapshot = {
      version: "0.1.0",
      schemaVersion: 5,
      logDir: null,
      activeAgents: 0,
      os: "linux",
      trayAvailable: true,
      totalMemoryBytes: null,
      cpuCount: 8,
    };
    let calls = 0;
    invokeMock.mockImplementation(() => {
      if (++calls === 1) return Promise.resolve(snapshot);
      return Promise.reject(new Error("托盘可性查询失败"));
    });

    await expect(systemBackend.info()).resolves.toEqual(snapshot);
  });

  it("浏览器态：无宿主 → info 返回 null", async () => {
    vi.stubGlobal("window", {});
    expect(systemBackend.active()).toBe(false);
    await expect(systemBackend.info()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
