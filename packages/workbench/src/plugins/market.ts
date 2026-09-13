import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";
import { computed, ref } from "vue";
import { adaptInstalledPlugin } from "./declarative";
import { createWorkerCodePluginRuntime, type CodePluginRuntime, type CodePluginRuntimeFactory } from "./code-runtime";
import { clearDeclarativePluginState } from "./declarative-state";
import type { InstalledPluginPackage, MarketPluginManifest, PluginInstallReport, PluginRegistryEntry } from "./market-types";
import { isPluginEnabled, pluginManifests, registerPlugin, setPluginEnabled, unregisterPlugin } from "./runtime";
import { useCapabilityLoader } from "./current";
import { setNetFetchTransportForHost } from "./capabilities";

if (isTauriRuntime()) {
  // net.fetch 能力走宿主 IPC：Rust 侧对 hosts 白名单做二次校验（纵深防御），
  // 且不受 webview 静态 CSP 的域名限制。
  setNetFetchTransportForHost(async (request) => {
    const response = await invoke<{ status: number; ok: boolean; headers: [string, string][]; body?: string }>("plugin_net_fetch", {
      request: {
        url: request.url,
        method: request.method,
        headers: Object.entries(request.headers ?? {}),
        allowedHosts: request.allowedHosts,
      },
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers ?? []) headers[key] = value;
    return { status: response.status, ok: response.ok, headers, body: response.body };
  });
}

/** 用户可覆盖为自己的 GitHub raw index；空串表示尚未配置线上目录。 */
const REGISTRY_URL_KEY = "greywork.plugins.registryUrl";
const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/jean3690/greywork-plugin-market/main/registry.json";

export const marketCatalog = ref<readonly PluginRegistryEntry[]>([]);
export const installedMarketPlugins = ref<readonly InstalledPluginPackage[]>([]);
export const marketLoading = ref(false);
export const marketBusyId = ref<string | null>(null);
export const marketError = ref("");
export const pluginRegistryUrl = ref(localStorage.getItem(REGISTRY_URL_KEY) ?? DEFAULT_REGISTRY_URL);
export const pluginMarketHostAvailable = isTauriRuntime();

const registeredInstalledIds = new Set<string>();
const codeRuntimes = new Map<string, CodePluginRuntime>();
let runtimeFactory: CodePluginRuntimeFactory = createWorkerCodePluginRuntime;

export const installedMarketIds = computed(() => new Set(installedMarketPlugins.value.map((item) => item.manifest.id)));

/** 已装插件中版本落后于目录的项（id → 目录新版本）。目录未加载/条目缺失不视为可升级。 */
export const outdatedPlugins = computed(() => {
  const byId = new Map(marketCatalog.value.map((entry) => [entry.id, entry]));
  const result: Record<string, string> = {};
  for (const installed of installedMarketPlugins.value) {
    const entry = byId.get(installed.manifest.id);
    if (entry && semverGreaterThan(entry.version, installed.manifest.version)) {
      result[installed.manifest.id] = entry.version;
    }
  }
  return result;
});

/** semver 主.次.修订比较：a > b 返回 true；解析失败视为不可比较（false）。 */
function semverGreaterThan(a: string, b: string): boolean {
  const parse = (version: string): number[] | null => {
    const parts = version.split(".");
    if (parts.length !== 3) return null;
    const numbers = parts.map((part) => Number(part));
    return numbers.every((n) => Number.isInteger(n) && n >= 0) ? numbers : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return false;
}

export function setPluginRegistryUrl(url: string): void {
  pluginRegistryUrl.value = url.trim();
  localStorage.setItem(REGISTRY_URL_KEY, pluginRegistryUrl.value);
}

function registerInstalled(packages: readonly InstalledPluginPackage[]): void {
  for (const pluginPackage of packages) {
    const id = pluginPackage.manifest.id;
    if (registeredInstalledIds.has(id) || pluginManifests.value.some((manifest) => manifest.id === id)) continue;
    // worker 运行时绑定 (id, loader)：插件 worker 内 greywork.call 的每次请求
    // 都经宿主 loader.callCapability 现场鉴权（声明 + 全局授权 + 注册表三重校验）。
    const runtime =
      pluginPackage.manifest.kind === "worker"
        ? runtimeFactory(pluginPackage, (capability, args) => useCapabilityLoader().callCapability(id, capability, args))
        : undefined;
    if (runtime) codeRuntimes.set(id, runtime);
    try {
      registerPlugin(adaptInstalledPlugin(pluginPackage, runtime));
      registeredInstalledIds.add(id);
    } catch (error) {
      runtime?.dispose();
      codeRuntimes.delete(id);
      throw error;
    }
  }
}

/** 测试 seam：生产始终使用真实 Web Worker adapter。 */
export function setCodePluginRuntimeFactoryForTest(factory: CodePluginRuntimeFactory | null): void {
  runtimeFactory = factory ?? createWorkerCodePluginRuntime;
}

/** Shell 启动前调用：桌面态扫描 app_data/plugins，并把已安装包接入同一 loader。 */
export async function bootInstalledMarketPlugins(): Promise<void> {
  if (!isTauriRuntime()) return;
  installedMarketPlugins.value = await invoke<InstalledPluginPackage[]>("plugin_market_list_installed");
  registerInstalled(installedMarketPlugins.value);
}

export async function refreshPluginCatalog(): Promise<void> {
  const url = pluginRegistryUrl.value.trim();
  if (!url) {
    marketCatalog.value = [];
    marketError.value = "请先配置 GitHub registry.json 地址";
    return;
  }
  marketLoading.value = true;
  marketError.value = "";
  try {
    if (pluginMarketHostAvailable) {
      const registry = await invoke<{ schemaVersion: 1; plugins: PluginRegistryEntry[] }>("plugin_market_catalog", { registryUrl: url });
      marketCatalog.value = registry.plugins;
    } else {
      const response = await fetch(url === DEFAULT_REGISTRY_URL ? "/market-api/plugins/registry.json" : url);
      if (!response.ok) throw new Error(`registry request returned ${response.status}`);
      const registry = (await response.json()) as { schemaVersion?: unknown; plugins?: unknown };
      if (registry.schemaVersion !== 1 || !Array.isArray(registry.plugins)) throw new Error("invalid plugin registry");
      marketCatalog.value = registry.plugins as PluginRegistryEntry[];
    }
  } catch (error) {
    marketCatalog.value = [];
    marketError.value = String(error);
  } finally {
    marketLoading.value = false;
  }
}

/**
 * 安装前预览：下载并全量校验（SHA-256 / schema / hosts）但不落盘，
 * 返回 manifest 供确认弹窗展示能力语义（requires + 危险等级 + 域名白名单）。
 */
export async function previewMarketPlugin(id: string): Promise<MarketPluginManifest> {
  if (!pluginMarketHostAvailable) throw new Error("plugin preview requires the desktop app");
  marketBusyId.value = id;
  marketError.value = "";
  try {
    return await invoke<MarketPluginManifest>("plugin_market_preview", {
      registryUrl: pluginRegistryUrl.value,
      pluginId: id,
    });
  } catch (error) {
    marketError.value = String(error);
    throw error;
  } finally {
    marketBusyId.value = null;
  }
}
export async function installMarketPlugin(id: string): Promise<PluginInstallReport> {
  if (!pluginMarketHostAvailable) throw new Error("plugin installation requires the desktop app");
  marketBusyId.value = id;
  marketError.value = "";
  try {
    const report = await invoke<PluginInstallReport>("plugin_market_install", {
      registryUrl: pluginRegistryUrl.value,
      pluginId: id,
    });
    installedMarketPlugins.value = await invoke<InstalledPluginPackage[]>("plugin_market_list_installed");
    registerInstalled(installedMarketPlugins.value);
    return report;
  } catch (error) {
    marketError.value = String(error);
    throw error;
  } finally {
    marketBusyId.value = null;
  }
}

/**
 * 升级已装插件到目录最新版：停用 → 注销旧清单 → Rust 覆盖落盘 → 重放注册 → 恢复启停。
 * 插件持久化状态（declarativeState）不清理 —— 升级保数据；启停偏好（enabled 存档）
 * 按原状态恢复。安装校验失败时旧版本仍在盘上，重放注册即可回滚。
 */
export async function upgradeMarketPlugin(id: string): Promise<PluginInstallReport> {
  if (!pluginMarketHostAvailable) throw new Error("plugin upgrade requires the desktop app");
  marketBusyId.value = id;
  marketError.value = "";
  const wasEnabled = isPluginEnabled(id);
  try {
    if (wasEnabled) await setPluginEnabled(id, false);
    codeRuntimes.get(id)?.dispose();
    codeRuntimes.delete(id);
    unregisterPlugin(id);
    registeredInstalledIds.delete(id);

    const report = await invoke<PluginInstallReport>("plugin_market_install", {
      registryUrl: pluginRegistryUrl.value,
      pluginId: id,
    });
    installedMarketPlugins.value = await invoke<InstalledPluginPackage[]>("plugin_market_list_installed");
    registerInstalled(installedMarketPlugins.value);
    if (wasEnabled) await setPluginEnabled(id, true);
    return report;
  } catch (error) {
    marketError.value = String(error);
    // 回滚：旧版本仍在盘上，重放注册并恢复升级前的启停状态。
    installedMarketPlugins.value = await invoke<InstalledPluginPackage[]>("plugin_market_list_installed");
    registerInstalled(installedMarketPlugins.value);
    if (wasEnabled) await setPluginEnabled(id, true);
    throw error;
  } finally {
    marketBusyId.value = null;
  }
}

export async function uninstallMarketPlugin(id: string): Promise<void> {
  if (!pluginMarketHostAvailable) throw new Error("plugin uninstallation requires the desktop app");
  marketBusyId.value = id;
  marketError.value = "";
  try {
    if (isPluginEnabled(id)) await setPluginEnabled(id, false);
    await invoke("plugin_market_uninstall", { pluginId: id });
    unregisterPlugin(id);
    codeRuntimes.get(id)?.dispose();
    codeRuntimes.delete(id);
    clearDeclarativePluginState(id);
    registeredInstalledIds.delete(id);
    installedMarketPlugins.value = installedMarketPlugins.value.filter((item) => item.manifest.id !== id);
  } catch (error) {
    marketError.value = String(error);
    throw error;
  } finally {
    marketBusyId.value = null;
  }
}
