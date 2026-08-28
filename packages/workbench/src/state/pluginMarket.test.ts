// 插件市场单例验收：localStorage 持久化登记、单例复用、安装后同步能力注册表。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@greywork/plugins";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
});

/** 每个测试独立模块实例（store 单例随模块缓存重建）。 */
async function loadModule() {
  return await import("./pluginMarket");
}

async function loadSeam() {
  return await import("../plugins/loader");
}

const mcpManifest: PluginManifest = {
  id: "mcp-foo",
  kind: "mcp-server",
  name: "Foo MCP",
  version: "1.0.0",
  transport: "stdio",
  command: "foo",
};

beforeEach(() => {
  storage.clear();
  vi.resetModules();
});

describe("registered-mcp 持久化", () => {
  it("persistRegisteredMcp 写入 localStorage，重复 id 去重", async () => {
    const { persistRegisteredMcp } = await loadModule();
    persistRegisteredMcp(mcpManifest);
    persistRegisteredMcp(mcpManifest);
    const raw = storage.get("greywork.registered-mcp") ?? "[]";
    expect(JSON.parse(raw)).toHaveLength(1);
    expect(JSON.parse(raw)[0]?.id).toBe("mcp-foo");
  });

  it("removeRegisteredMcp 移除登记", async () => {
    const { persistRegisteredMcp, removeRegisteredMcp } = await loadModule();
    persistRegisteredMcp(mcpManifest);
    removeRegisteredMcp("mcp-foo");
    expect(storage.get("greywork.registered-mcp")).toBe("[]");
  });
});

describe("getPluginMarket 单例", () => {
  it("重复调用返回同一实例，并恢复预置安装", async () => {
    const { getPluginMarket } = await loadModule();
    const market = getPluginMarket();
    expect(getPluginMarket()).toBe(market);
    expect(market.installedIds()).toContain("skill-gis");
    expect(market.installedIds()).toContain("ext-github");
  });

  it("安装 ui 插件后，贡献出现在全局 capabilitySeam；卸载后消失", async () => {
    const { getPluginMarket } = await loadModule();
    const { capabilitySeam } = await loadSeam();
    const market = getPluginMarket();

    expect(market.install("ext-gis")).toBe(true);
    await vi.waitFor(() => {
      expect(capabilitySeam.snapshot().modes.map((mode) => mode.id)).toContain("ext:ext-gis:gis");
    });

    expect(market.uninstall("ext-gis")).toBe(true);
    await vi.waitFor(() => {
      expect(capabilitySeam.snapshot().modes.map((mode) => mode.id)).not.toContain("ext:ext-gis:gis");
      expect(capabilitySeam.activeIds()).not.toContain("ext-gis");
    });
  });
});
