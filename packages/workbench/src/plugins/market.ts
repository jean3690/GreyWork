/**
 * 已安装插件加载器 + 插件能力宿主通道。
 *
 * 远端插件市场已下线：这里只负责把宿主数据目录里**已经落盘**的插件包扫描出来、
 * 注册进 loader（含 worker 运行时与渲染循环），不再有 registry 目录 / 下载 / 安装 / 卸载。
 * 文件名与导出名沿用历史的 `market` 说法，避免与插件安装态（installed）混淆改动面。
 */
import { hasHostCommands, hostClipboard, hostPlugins, invoke } from "@greywork/host-ipc";
import { ref } from "vue";
import { adaptInstalledPlugin } from "./declarative";
import { createWorkerCodePluginRuntime, type CodePluginRuntime, type CodePluginRuntimeFactory } from "./code-runtime";
import type { InstalledPluginPackage } from "./market-types";
import { activateRegisteredPluginFromArchive, pluginManifests, registerPlugin } from "./runtime";
import { useCapabilityLoader } from "./current";
import {
  setNetFetchTransportForHost,
  setPluginArtifactPublisher,
  setPluginClipboardTransportForHost,
  setPluginFsTransportForHost,
  setPluginLlmChatTransportForHost,
  setPluginMcpTransportForHost,
  setPluginNotifyTransportForHost,
  setPluginWorkspaceTransportForHost,
} from "./capabilities";
import { setPluginStatus } from "./status";

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
  // mcp.connect：manifest 只给服务器名，连接参数（url / command / env / headers）在这里
  // 从**用户设置**里按名字解析。插件全程看不到凭据，也指定不了要连哪台机器。
  setPluginMcpTransportForHost(async (request) => {
    const { useSettingsStore } = await import("@/stores/settings");
    const entry = useSettingsStore().mcpServers.find((server) => server.enabled && server.name.trim() === request.server.trim());
    if (!entry) {
      throw new Error(`mcp.connect: server is not configured or enabled in settings: ${request.server}`);
    }
    return invoke<{ transport: string; isError: boolean; text: string; durationMs: number }>("plugin_mcp_call", {
      request: {
        pluginId: request.pluginId,
        server: entry.name,
        transport: entry.transport,
        url: entry.url,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        headers: entry.headers,
        tool: request.tool,
        arguments: request.arguments,
        allowedTools: request.allowedTools,
      },
    });
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

/** 宿主数据目录里扫描到的已安装包（启动时由 bootInstalledMarketPlugins 填充）。 */
export const installedMarketPlugins = ref<readonly InstalledPluginPackage[]>([]);

const registeredInstalledIds = new Set<string>();
const codeRuntimes = new Map<string, CodePluginRuntime>();
let runtimeFactory: CodePluginRuntimeFactory = createWorkerCodePluginRuntime;

function registerInstalled(packages: readonly InstalledPluginPackage[]): void {
  for (const pluginPackage of packages) {
    const id = pluginPackage.manifest.id;
    if (registeredInstalledIds.has(id) || pluginManifests.value.some((manifest) => manifest.id === id)) continue;
    // worker 运行时绑定 (id, loader)：插件 worker 内 greywork.call 的每次请求
    // 都经宿主 loader.callCapability 现场鉴权（声明 + 全局授权 + 注册表三重校验）。
    const runtime =
      pluginPackage.manifest.kind === "worker"
        ? runtimeFactory(
            pluginPackage,
            (capability, args) => useCapabilityLoader().callCapability(id, capability, args),
            // 状态栏更新：id 必须来自本包声明的条目，否则丢弃（防止写到别人家的条目上）。
            (statusId, text) => {
              const declared = pluginPackage.manifest.contributes.statusBar?.some((entry) => entry.id === statusId);
              if (declared) setPluginStatus(id, statusId, text);
            },
          )
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
