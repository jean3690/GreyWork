import { createJsonStorage } from "@greywork/core";
import { createPluginStore, SAMPLE_MARKET_MANIFESTS, type PluginManifest, type PluginStore } from "@greywork/plugins";
import { syncMarketToCapabilities } from "../plugins/bridge";

/**
 * 插件市场单例（模块级懒初始化）：MarketView 与侧栏指标共用同一份
 * 已安装状态；后续接真实 @greywork/plugins 运行时只改此文件。
 *
 * 已安装插件会经 bridge 同步到 capabilitySeam，使安装/卸载产生可见 UI 贡献。
 */

const REGISTERED_MCP_KEY = "greywork.registered-mcp";

function isMcpManifestArray(value: unknown): value is PluginManifest[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item): item is PluginManifest => typeof item === "object" && item !== null && (item as { kind?: unknown }).kind === "mcp-server",
    )
  );
}

const registeredMcpStorage = createJsonStorage<PluginManifest[]>(REGISTERED_MCP_KEY, isMcpManifestArray);

/** 读取用户从官方注册表登记的 MCP manifest（跨会话持久化）。 */
function loadRegisteredMcp(): PluginManifest[] {
  return registeredMcpStorage.read() ?? [];
}

/** 登记成功后调用：追加持久化（按 id 去重）。 */
export function persistRegisteredMcp(manifest: PluginManifest): void {
  const existing = loadRegisteredMcp();
  if (existing.some((item) => item.id === manifest.id)) return;
  registeredMcpStorage.write([...existing, manifest]);
}

export function removeRegisteredMcp(id: string): void {
  registeredMcpStorage.write(loadRegisteredMcp().filter((item) => item.id !== id));
}

let store: PluginStore | null = null;

export function getPluginMarket() {
  if (!store) {
    // 用户登记过的远程 MCP manifest 并入市场（展开拷贝，避免污染 plugins 包共享数组）；
    // install 状态由 store 自行从 localStorage 恢复。
    const remoteManifests = loadRegisteredMcp();
    const marketplace = [
      ...SAMPLE_MARKET_MANIFESTS,
      ...remoteManifests.filter((manifest) => !SAMPLE_MARKET_MANIFESTS.some((sample) => sample.id === manifest.id)),
    ];
    const raw = createPluginStore({
      remoteMarketplace: marketplace,
      initialInstalled: ["skill-gis", "ext-github"],
      storageKey: "greywork.installed-plugins",
      persist: true,
    });
    // 包装 install/uninstall：状态变更后同步能力注册表，使安装/卸载产生 UI 变化。
    const install = raw.install.bind(raw);
    const uninstall = raw.uninstall.bind(raw);
    raw.install = (id: string): boolean => {
      const ok = install(id);
      if (ok) void syncMarketToCapabilities(raw);
      return ok;
    };
    raw.uninstall = (id: string): boolean => {
      const ok = uninstall(id);
      if (ok) void syncMarketToCapabilities(raw);
      return ok;
    };
    store = raw;
    // 恢复持久化安装：已安装插件在启动时重新注册到能力注册表。
    void syncMarketToCapabilities(store);
  }
  return store;
}
