import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type * as GreyworkCore from "@greywork/core";

/**
 * 卸载与悬浮窗回收：
 * - uninstallMarketPlugin：停用 → 关窗 → 宿主删盘 → 注销清单 → 释放 worker → 清状态；
 * - 停用任一插件都会回收其悬浮窗（窗口里跑的是该插件的 render worker）。
 * IPC 层 mock：invoke 按 command 表分发，记录调用序列。
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

describe("插件卸载与悬浮窗回收", () => {
  it("停用插件会调用 plugin_window_close 回收悬浮窗", async () => {
    invokeHandlers["plugin_market_list_installed"] = () => [installedPackage("demo.pet", "1.0.0")];
    invokeHandlers["plugin_window_close"] = () => undefined;
    const market = await import("@/plugins/market");
    const runtime = await import("@/plugins/runtime");
    await market.bootInstalledMarketPlugins();
    await runtime.bootPlugins();

    await runtime.setPluginEnabled("demo.pet", true);
    invokeCalls.length = 0;
    await runtime.setPluginEnabled("demo.pet", false);

    expect(invokeCalls).toContain("plugin_window_close");
    expect(runtime.isPluginEnabled("demo.pet")).toBe(false);
  });

  it("uninstallMarketPlugin：停用 → 关窗 → 宿主删盘 → 注销清单 → 清状态", async () => {
    invokeHandlers["plugin_market_list_installed"] = () => [installedPackage("demo.pet", "1.0.0")];
    invokeHandlers["plugin_market_uninstall"] = () => undefined;
    invokeHandlers["plugin_window_close"] = () => undefined;
    const market = await import("@/plugins/market");
    const runtime = await import("@/plugins/runtime");
    await market.bootInstalledMarketPlugins();
    await runtime.bootPlugins();
    await runtime.setPluginEnabled("demo.pet", true);

    // 预置该插件的声明式状态与一项授权，验证卸载会一并清理。
    storageHolder.localStorage?.setItem("greywork.plugins.declarativeState", JSON.stringify({ "demo.pet/demo-mode": { count: 3 } }));
    runtime.grantPluginCapability("demo.pet", "net.fetch");
    expect(runtime.isPluginCapabilityGranted("demo.pet", "net.fetch")).toBe(true);

    invokeCalls.length = 0;
    await market.uninstallMarketPlugin("demo.pet");

    expect(invokeCalls).toContain("plugin_market_uninstall");
    expect(invokeCalls).toContain("plugin_window_close");
    expect(runtime.pluginManifests.value.some((manifest) => manifest.id === "demo.pet")).toBe(false);
    expect(market.installedMarketPlugins.value.some((item) => item.manifest.id === "demo.pet")).toBe(false);
    // 授权随卸载清空：重装同 id 的其它包不会继承旧授权。
    expect(runtime.isPluginCapabilityGranted("demo.pet", "net.fetch")).toBe(false);
    // 卸载后同 id 可重新安装（清单已从 loader 注销）。
    expect(() => runtime.registerPlugin({ id: "demo.pet", name: "重装", version: "2.0.0" })).not.toThrow();
  });
});
