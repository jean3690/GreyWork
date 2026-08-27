import { createPluginStore, SAMPLE_MARKET_MANIFESTS, type PluginManifest, type PluginStore } from "@greywork/plugins";

/**
 * 插件市场单例（模块级懒初始化）：MarketView 与侧栏指标共用同一份
 * 已安装状态；后续接真实 @greywork/plugins 运行时只改此文件。
 */

const REGISTERED_MCP_KEY = "greywork.registered-mcp";

/** 读取用户从官方注册表登记的 MCP manifest（跨会话持久化）。 */
function loadRegisteredMcp(): PluginManifest[] {
  try {
    const raw = localStorage.getItem(REGISTERED_MCP_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PluginManifest => typeof item === "object" && item !== null && (item as { kind?: unknown }).kind === "mcp-server",
    );
  } catch {
    return [];
  }
}

/** 登记成功后调用：追加持久化（按 id 去重）。 */
export function persistRegisteredMcp(manifest: PluginManifest): void {
  const existing = loadRegisteredMcp();
  if (existing.some((item) => item.id === manifest.id)) return;
  localStorage.setItem(REGISTERED_MCP_KEY, JSON.stringify([...existing, manifest]));
}

export function removeRegisteredMcp(id: string): void {
  const existing = loadRegisteredMcp().filter((item) => item.id !== id);
  localStorage.setItem(REGISTERED_MCP_KEY, JSON.stringify(existing));
}

let store: PluginStore | null = null;

export function getPluginMarket() {
  if (!store) {
    // 用户登记过的远程 MCP manifest 先回灌市场，install 状态由 store 自行恢复
    const remoteManifests = loadRegisteredMcp();
    for (const manifest of remoteManifests) {
      if (!SAMPLE_MARKET_MANIFESTS.some((sample) => sample.id === manifest.id)) {
        SAMPLE_MARKET_MANIFESTS.push(manifest);
      }
    }
    store = createPluginStore({
      remoteMarketplace: SAMPLE_MARKET_MANIFESTS,
      initialInstalled: ["skill-gis", "ext-github"],
      storageKey: "greywork.installed-plugins",
      persist: true,
    });
  }
  return store;
}
