import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type * as GreyworkCore from "@greywork/core";

/**
 * 停用插件时的悬浮窗回收：窗口里跑的是该插件的 render worker，停用必须一并关窗。
 *
 * 远端插件市场已下线，这里只用宿主扫描出的「已安装包」（plugin_market_list_installed）
 * 构造启停场景；IPC 层 mock：invoke 按 command 表分发，记录调用序列。
 */

const invokeHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {};
const invokeCalls: string[] = [];

const invokeMock = vi.hoisted(() =>
  vi.fn(async (command: string, args: Record<string, unknown>) => {
    invokeCalls.push(command);
    const handler = invokeHandlers[command];
    if (!handler) throw new Error(`no mock for command: ${command}`);
    return handler(args);
  }),
);

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: invokeMock,
}));

vi.mock("@greywork/core", async (importOriginal) => {
  const actual = await importOriginal<typeof GreyworkCore>();
  return { ...actual, isTauriRuntime: () => true };
});

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
  window.localStorage.clear();
  // 桌面态 = 宿主托管：bootInstalledMarketPlugins 的闸门是 hasHostCommands()。
  (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__ = "server";
  // 悬浮窗回收走 bridge.plugins（Electron 主进程托管窗口）——桩方法路由回 invoke 记录。
  (window as unknown as Record<string, unknown>).__GREYWORK_SHELL__ = {
    window: {},
    plugins: {
      notify: (request: unknown) => invokeMock("plugin_notify", { request } as Record<string, unknown>),
      openWindow: (pluginId: string) => invokeMock("plugin_window_open", { pluginId } as Record<string, unknown>),
      closeWindow: (pluginId: string) => invokeMock("plugin_window_close", { pluginId } as Record<string, unknown>),
    },
  };
  setActivePinia(createPinia());
  const installed = await import("@/plugins/market");
  installed.setCodePluginRuntimeFactoryForTest(() => ({
    invoke: () => Promise.resolve(undefined),
    invokeRaw: () => Promise.resolve([]),
    dispatchPointer: () => Promise.resolve(undefined),
    dispose: () => undefined,
  }));
  invokeCalls.length = 0;
  for (const key of Object.keys(invokeHandlers)) delete invokeHandlers[key];
});

afterEach(() => {
  vi.clearAllMocks();
  void import("@/plugins/market").then((installed) => installed.setCodePluginRuntimeFactoryForTest(null));
});

describe("插件停用与悬浮窗回收", () => {
  it("停用插件会调用 plugin_window_close 回收悬浮窗", async () => {
    invokeHandlers["plugin_market_list_installed"] = () => [installedPackage("demo.pet", "1.0.0")];
    invokeHandlers["plugin_window_close"] = () => undefined;
    const installed = await import("@/plugins/market");
    const runtime = await import("@/plugins/runtime");
    await installed.bootInstalledMarketPlugins();
    await runtime.bootPlugins();

    await runtime.setPluginEnabled("demo.pet", true);
    invokeCalls.length = 0;
    await runtime.setPluginEnabled("demo.pet", false);

    expect(invokeCalls).toContain("plugin_window_close");
    expect(runtime.isPluginEnabled("demo.pet")).toBe(false);
  });
});
