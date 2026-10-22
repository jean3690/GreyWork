import { hasHostCommands, hostClipboard, hostPlugins, invoke } from "@greywork/host-ipc";
import { computed, ref } from "vue";
import { adaptInstalledPlugin } from "./declarative";
import { createWorkerCodePluginRuntime, type CodePluginRuntime, type CodePluginRuntimeFactory } from "./code-runtime";
import { clearDeclarativePluginState } from "./declarative-state";
import type { InstalledPluginPackage, MarketPluginManifest, PluginInstallReport, PluginRegistryEntry } from "./market-types";
import {
  activateRegisteredPluginFromArchive,
  clearPluginCapabilityGrants,
  isPluginEnabled,
  pluginManifests,
  registerPlugin,
  setPluginEnabled,
  unregisterPlugin,
} from "./runtime";
import { useCapabilityLoader } from "./current";
import {
  setNetFetchTransportForHost,
  setPluginArtifactPublisher,
  setPluginClipboardTransportForHost,
  setPluginFsTransportForHost,
  setPluginLlmChatTransportForHost,
  setPluginNotifyTransportForHost,
  setPluginWorkspaceTransportForHost,
} from "./capabilities";
import { closePluginWindow } from "./plugin-window";

/**
 * 把 net.fetch 能力挂到宿主 IPC：Rust 侧对 hosts 白名单做二次校验（纵深防御），
 * 且不受 webview 静态 CSP 的域名限制。没有宿主时保持 webview fetch 兜底。
 *
 * **必须在 runtime 判定之后调用**（见 bootInstalledMarketPlugins），不能在模块顶层按运行时
 * 分流：本模块经 workbench/index.ts 在入口求值，早于 initRuntimeMode()，那一刻恒为 browser-preview。
 */
export function initPluginHostTransport(): void {
  if (!hasHostCommands()) return;
  setNetFetchTransportForHost(async (request) => {
    const response = await invoke<{ status: number; ok: boolean; headers: [string, string][]; body?: string }>("plugin_net_fetch", {
      request: {
        url: request.url,
        method: request.method,
        headers: Object.entries(request.headers ?? {}),
        body: request.body,
        allowedHosts: request.allowedHosts,
        methods: request.methods,
        paths: request.paths,
        maxBytes: request.maxBytes,
      },
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers ?? []) headers[key] = value;
    return { status: response.status, ok: response.ok, headers, body: response.body };
  });
  setPluginFsTransportForHost(async (request) => {
    const response = await invoke<{
      bytes: number;
      totalBytes: number;
      data?: string;
      entries?: { name: string; dir: boolean; bytes: number }[];
      removed?: boolean;
      exists?: boolean;
    }>("plugin_fs", { request });
    return response;
  });
  // workspace.read：宿主侧复用 WorkspaceFsAccess（授权根 + 256 KiB 文本预览）。
  setPluginWorkspaceTransportForHost(async (request) => {
    return invoke<{
      roots?: { path: string; name: string }[];
      path?: string;
      name?: string;
      data?: string;
      bytes?: number;
      truncated?: boolean;
      exists?: boolean;
    }>("plugin_workspace", { request });
  });
  // llm.chat：按**当前设置**解析供应商（baseUrl / 密钥变量名），模型已由能力层按 manifest
  // 白名单校验。设置 store 用动态 import：本模块在入口求值，且 plugins 层不静态依赖 stores。
  setPluginLlmChatTransportForHost(async (request) => {
    const [{ useSettingsStore }, { selectLlmProvider }] = await Promise.all([import("@/stores/settings"), import("@/lib/llm-provider")]);
    const settings = useSettingsStore();
    const provider = selectLlmProvider(settings.modelProviders, settings.selectedModelProviderId);
    if (!provider) throw new Error("llm.chat requires a configured model provider");
    const messages = [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content: request.prompt }];
    // 宿主自己从环境变量解析密钥：这里只传变量名，明文 key 不经过插件、也不经过本层。
    const text = await invoke<string>("llm_chat_complete", {
      baseUrl: provider.baseUrl ?? "",
      model: request.model,
      apiKeyEnv: provider.apiKeyEnv ?? "",
      messages,
      reasoningEffort: provider.reasoningEffort ?? "auto",
      headers: provider.headers,
    });
    return { text, model: request.model };
  });
  // notify 是**桌面专属**能力（Tauri / Electron）：只在有原生桌面壳时注册传输层。
  // 纯服务端（自托管 web）不注册，插件调用会按「无宿主」失败并记审计 —— 这正是
  // capabilities.ts 对 notify 的既有约定，也避免去 invoke `plugin_notify` 撞 403。
  const plugins = hostPlugins();
  if (plugins) {
    setPluginNotifyTransportForHost((request) => plugins.notify(request));
  }
}

/**
 * artifacts.publish 的落点：产物面板是**前端**概念（VFS + 产物卡片），web 预览同样可用，
 * 所以不挂在 initPluginHostTransport 里 —— 那条路径没有宿主命令就直接返回。
 *
 * 动态 import 产物 store：本模块在入口求值，且 plugins 层不静态依赖 stores。
 * 落盘 / 登记卡片 / 广播事件全部复用 deliverArtifact，插件只是多了一个内容来源。
 */
setPluginArtifactPublisher(async (request) => {
  const { useArtifactStore } = await import("@/stores/artifact");
  const id = await useArtifactStore().deliverArtifact({
    name: request.name,
    path: request.path,
    meta: `插件 · ${request.pluginId}`,
    type: "report",
    source: `plugin:${request.pluginId}`,
    format: request.format,
    data: request.data,
  });
  return { id };
});

/**
 * clipboard 的落点：宿主剪贴板门面按运行时选路（Electron 主进程 / 浏览器 Web API）。
 * 每次调用现取门面而不是模块求值时捕获 —— Electron 的 bridge 在 preload 注入后才可用，
 * 且浏览器态的 navigator.clipboard 也只在调用时才有意义。
 */
setPluginClipboardTransportForHost({
  writeText: (text) => hostClipboard().writeText(text),
  readText: () => hostClipboard().readText(),
});

/** 用户可覆盖为自己的 GitHub raw index；空串表示尚未配置线上目录。 */
const REGISTRY_URL_KEY = "greywork.plugins.registryUrl";
const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/jean3690/greywork-plugin-market/main/registry.json";

export const marketCatalog = ref<readonly PluginRegistryEntry[]>([]);
export const installedMarketPlugins = ref<readonly InstalledPluginPackage[]>([]);
export const marketLoading = ref(false);
export const marketBusyId = ref<string | null>(null);
export const marketError = ref("");
export const pluginRegistryUrl = ref(localStorage.getItem(REGISTRY_URL_KEY) ?? DEFAULT_REGISTRY_URL);
/**
 * 当前运行时能否走宿主安装通道。
 *
 * 刻意是**函数**而不是模块常量：本模块经 workbench/index.ts 在入口求值，早于 initRuntimeMode()，
 * 那一刻 runtimeMode() 还是 browser-preview —— 常量会永久冻结为 false，服务端模式下插件市场静默失效。
 */
export function pluginMarketHostAvailable(): boolean {
  return hasHostCommands();
}

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
      // 清单与 boot 并发：boot 之后才注册的插件按启停存档补激活（boot 之前注册的由 wanted 集覆盖）。
      void activateRegisteredPluginFromArchive(id);
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

/**
 * 有宿主时扫描 app_data/plugins，并把已安装包接入同一 loader；顺带挂上 net.fetch 的宿主通道。
 *
 * **不必等它落地再挂载**：注册是纯追加（重复 id 由 pluginManifests 去重跳过），
 * 插件贡献的导航项走响应式快照，晚一帧到会自己补上。调用方（main.ts）因此与
 * mount 并发发起、不 await —— 别把这次读盘 IPC 重新串回首帧前面。
 */
export async function bootInstalledMarketPlugins(): Promise<void> {
  if (!hasHostCommands()) return;
  initPluginHostTransport();
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
    if (pluginMarketHostAvailable()) {
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
  if (!pluginMarketHostAvailable()) throw new Error("plugin preview requires the desktop app");
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
  if (!pluginMarketHostAvailable()) throw new Error("plugin installation requires the desktop app");
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
  if (!pluginMarketHostAvailable()) throw new Error("plugin upgrade requires the desktop app");
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
  if (!pluginMarketHostAvailable()) throw new Error("plugin uninstallation requires the desktop app");
  marketBusyId.value = id;
  marketError.value = "";
  try {
    if (isPluginEnabled(id)) await setPluginEnabled(id, false);
    // 停用路径已关窗；这里再兜一次，覆盖「未启用但窗口曾开过」的残留。
    await closePluginWindow(id);
    await invoke("plugin_market_uninstall", { pluginId: id });
    unregisterPlugin(id);
    clearPluginCapabilityGrants(id);
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
