import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type * as GreyworkCore from "@greywork/core";

/**
 * 升级路径单测：outdatedPlugins 检测（已装 vs 目录版本）与
 * upgradeMarketPlugin 的状态保全语义（启停恢复 / 注册重放 / 失败回滚）。
 * IPC 层 mock：invoke 按 command 表分发，验证宿主命令序列。
 */

const invokeHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {};
const invokeCalls: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    invokeCalls.push(command);
    const handler = invokeHandlers[command];
    if (!handler) throw new Error(`no mock for command: ${command}`);
    return handler(args);
  }),
}));

vi.mock("@greywork/core", async (importOriginal) => {
  const actual = await importOriginal<typeof GreyworkCore>();
  return { ...actual, isTauriRuntime: () => true };
});

const storageHolder = globalThis as { localStorage?: Storage };

function injectStorage(): void {
  const backing: Record<string, string> = {};
  storageHolder.localStorage = {
    getItem: (key: string) => backing[key] ?? null,
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => delete backing[key],
    clear: () => {
      for (const key of Object.keys(backing)) delete backing[key];
    },
    key: (index: number) => Object.keys(backing)[index] ?? null,
    get length() {
      return Object.keys(backing).length;
    },
  } as Storage;
}

/** 构造一个已安装的 market 包（worker 形态，走升级热路径）。 */
function installedPackage(id: string, version: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    code: 'greywork.registerAction("noop", () => ({}));',
    manifest: {
      id,
      name: id,
      version,
      kind: "worker",
      runtime: { type: "worker", entry: "https://raw.githubusercontent.com/acme/demo/main/index.js", sha256: "a".repeat(64) },
      requires: [],
      contributes: {
        modes: [{ id: "demo-mode", title: "Demo", icon: "magic", page: { heading: "h", body: "b", fields: [], outputs: [], actions: [] } }],
      },
    },
  };
}

beforeEach(async () => {
  injectStorage();
  setActivePinia(createPinia());
  // jsdom 无 Worker：注入假 worker runtime（升级路径不关心 worker 内部）。
  const market = await import("@/plugins/market");
  market.setCodePluginRuntimeFactoryForTest(() => ({
    invoke: () => Promise.resolve(undefined),
    invokeRaw: () => Promise.resolve([]),
    dispose: () => undefined,
  }));
  invokeCalls.length = 0;
  for (const key of Object.keys(invokeHandlers)) delete invokeHandlers[key];
});

afterEach(() => {
  vi.clearAllMocks();
  void import("@/plugins/market").then((market) => market.setCodePluginRuntimeFactoryForTest(null));
});

describe("插件升级", () => {
  it("outdatedPlugins：目录版本更高才可升级；同版/更低/目录缺失不算", async () => {
    invokeHandlers["plugin_market_list_installed"] = () => [installedPackage("demo.pet", "1.0.0")];
    const { bootInstalledMarketPlugins, refreshPluginCatalog, outdatedPlugins } = await import("@/plugins/market");
    await bootInstalledMarketPlugins();

    // 目录：pet 有 1.2.0（可升级）、worker 1.0.0（未装）。
    invokeHandlers["plugin_market_catalog"] = () => ({
      schemaVersion: 1,
      plugins: [
        { id: "demo.pet", name: "Pet", version: "1.2.0", downloadUrl: "x", sha256: "a".repeat(64) },
        { id: "demo.worker", name: "Worker", version: "1.0.0", downloadUrl: "x", sha256: "a".repeat(64) },
      ],
    });
    await refreshPluginCatalog();
    expect(outdatedPlugins.value).toEqual({ "demo.pet": "1.2.0" });

    // 目录降到同版：不再可升级。
    invokeHandlers["plugin_market_catalog"] = () => ({
      schemaVersion: 1,
      plugins: [{ id: "demo.pet", name: "Pet", version: "1.0.0", downloadUrl: "x", sha256: "a".repeat(64) }],
    });
    await refreshPluginCatalog();
    expect(outdatedPlugins.value).toEqual({});

    // 目录版本更低（1.0.0 → 0.9.0）：不算可升级。
    invokeHandlers["plugin_market_catalog"] = () => ({
      schemaVersion: 1,
      plugins: [{ id: "demo.pet", name: "Pet", version: "0.9.0", downloadUrl: "x", sha256: "a".repeat(64) }],
    });
    await refreshPluginCatalog();
    expect(outdatedPlugins.value).toEqual({});
  });

  it("upgradeMarketPlugin：停用→覆盖安装→重放注册→恢复启停，状态保全", async () => {
    let diskVersion = "1.0.0";
    invokeHandlers["plugin_market_list_installed"] = () => [installedPackage("demo.pet", diskVersion)];
    invokeHandlers["plugin_market_install"] = () => {
      diskVersion = "1.2.0";
      return { id: "demo.pet", version: "1.2.0", path: "/data/plugins/demo.pet/plugin.json" };
    };
    const market = await import("@/plugins/market");
    const runtime = await import("@/plugins/runtime");
    await market.bootInstalledMarketPlugins();
    await runtime.bootPlugins();

    // 启用旧版（manifest 注册后激活）。
    await runtime.setPluginEnabled("demo.pet", true);
    expect(runtime.isPluginEnabled("demo.pet")).toBe(true);

    await market.upgradeMarketPlugin("demo.pet");

    // 升级后：版本翻新 + 启停恢复 + manifest 重放（版本反映在 pluginManifests）。
    expect(runtime.isPluginEnabled("demo.pet")).toBe(true);
    expect(runtime.pluginManifests.value.find((manifest) => manifest.id === "demo.pet")?.version).toBe("1.2.0");
    // 命令序列：停用由前端发起（enable 存档写回），安装走宿主，列表重读。
    expect(invokeCalls).toContain("plugin_market_install");
    expect(invokeCalls.filter((command) => command === "plugin_market_list_installed").length).toBeGreaterThanOrEqual(2);
  });

  it("upgradeMarketPlugin 失败回滚：旧版本重放注册，启停不丢", async () => {
    let installFails = false;
    invokeHandlers["plugin_market_list_installed"] = () => [installedPackage("demo.pet", "1.0.0")];
    invokeHandlers["plugin_market_install"] = () => {
      if (installFails) throw new Error("checksum mismatch");
      return { id: "demo.pet", version: "1.0.0", path: "/x" };
    };
    const market = await import("@/plugins/market");
    const runtime = await import("@/plugins/runtime");
    await market.bootInstalledMarketPlugins();
    await runtime.bootPlugins();
    await runtime.setPluginEnabled("demo.pet", true);

    installFails = true;
    await expect(market.upgradeMarketPlugin("demo.pet")).rejects.toThrow("checksum mismatch");

    // 回滚：旧 manifest 仍在册，启停恢复（升级中途被停用的插件重放后重新激活）。
    expect(runtime.pluginManifests.value.some((manifest) => manifest.id === "demo.pet")).toBe(true);
    expect(runtime.isPluginEnabled("demo.pet")).toBe(true);
  });
});
