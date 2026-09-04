/**
 * settings store 桌面态（SQLite 真源）接管语义测试。
 *
 * - 库已接管（load 返回快照）→ hydrate 后库内容覆盖本地缓存并幂等回写；
 * - 库未接管（load=null）→ 当前默认/缓存值作为真源首落库；
 * - load 失败 → 降级沿用本地，不抛错。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

import { useSettingsStore } from "../../src/stores/settings";

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

const dbSettings = {
  theme: "light",
  locale: "en-US",
  selectedModelProviderId: "opencode",
  modelProviders: [{ id: "opencode", name: "OpenCode", model: "ling-3.0-flash-fin-free", enabled: true, reasoningEffort: "high" }],
  cliIntegrations: [],
};

describe("settings store 桌面接管（SQLite 真源）", () => {
  beforeEach(() => {
    installLocalStorage();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invokeMock.mockReset();
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete storageHolder.localStorage;
  });

  it("库已接管：hydrate 后库快照覆盖本地默认（含校验回退）", async () => {
    invokeMock.mockResolvedValue(dbSettings);
    const settings = useSettingsStore();
    await settings.hydrated;

    expect(invokeMock).toHaveBeenCalledWith("db_settings_load");
    expect(settings.theme).toBe("light");
    expect(settings.locale).toBe("en-US");
    expect(settings.selectedModelProviderId).toBe("opencode");
    expect(settings.modelProviders[0].reasoningEffort).toBe("high");
    // 幂等回写（本地缓存与真源对齐）
    expect(invokeMock).toHaveBeenCalledWith("db_settings_sync", expect.objectContaining({ settings: expect.any(Object) }));
  });

  it("库未接管：load=null → 默认值首落库", async () => {
    invokeMock.mockResolvedValue(null);
    const settings = useSettingsStore();
    await settings.hydrated;

    expect(settings.theme).toBe("dark");
    expect(invokeMock).toHaveBeenCalledWith(
      "db_settings_sync",
      expect.objectContaining({ settings: expect.objectContaining({ theme: "dark" }) }),
    );
  });

  it("load 失败：降级沿用本地默认，不抛错", async () => {
    invokeMock.mockRejectedValue(new Error("库损坏"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const settings = useSettingsStore();
    await settings.hydrated;

    expect(settings.theme).toBe("dark");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("变更经 persist 双写回库", async () => {
    invokeMock.mockResolvedValue(dbSettings);
    const settings = useSettingsStore();
    await settings.hydrated;

    settings.theme = "system";
    settings.persist();
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_settings_sync",
      expect.objectContaining({ settings: expect.objectContaining({ theme: "system" }) }),
    );
  });
});
