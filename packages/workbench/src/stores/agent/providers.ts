/**
 * 后端目录切片（Agent 管理面）：preset 注册表 × 持久化状态（本地 JSON / SQLite）的合并、
 * 图标覆盖层、安装探测、启停持久化，以及首页 ACP/Local 之间的路由切换。
 *
 * 依赖 runtime 切片的 connectAcp / dismissPendingPermission / setAcpConfig
 * （经 getRuntime 惰性访问，运行时才绑定，避免切片间建文件时的循环）。
 */
import type { AgentProviderConfig } from "@greywork/shell";
import { watch } from "vue";
import { acp } from "../../lib/acp-client";
import { agentsBackend, type AgentProviderRow } from "../../lib/agents-backend";
import { notify } from "../notice";
import {
  detectProgramOf,
  isCustomAgentProvider,
  newCustomProviderId,
  providerIconsStorage,
  providerPrefStorage,
  providersStorage,
  t,
} from "./shared";
import type { AgentStoreState } from "./state";
import type { RuntimeApi } from "./runtime";

export interface ProvidersDeps {
  state: AgentStoreState;
  getRuntime: () => RuntimeApi;
}

export interface ProvidersApi {
  refreshAgentDetection(): Promise<void>;
  providerInstalled(provider: AgentProviderConfig): boolean | null;
  providerInstallLabel(provider: AgentProviderConfig): string;
  setAgentProviderEnabled(id: string, enabled: boolean): Promise<void>;
  setAgentProviderIcon(id: string, icon: string | null): void;
  addAgentProvider(name: string, command: string, icon?: string): string | null;
  updateAgentProvider(id: string, name: string, command: string, icon?: string): string | null;
  removeAgentProvider(id: string): Promise<string | null>;
  activateAcpProvider(id: string): Promise<string | null>;
  applyWorkspaceAgentConfig(workspaceId: string | null): Promise<void>;
  selectProvider(id: string): void;
  toggleRouteToAcp(): void;
  switchToLocalLlm(): Promise<void>;
}

export function createProvidersSlice({ state, getRuntime }: ProvidersDeps): ProvidersApi {
  const runtime = (): RuntimeApi => getRuntime();

  /* ===== 初始接续：seed 顶层 refs（对齐原 agent.ts setup 的同步执行顺序） ===== */

  /** 把覆盖层（或空）盖到当前目录上：真源重建目录后图标不能丢，故每次重建都要重跑。 */
  function applyProviderIcons(): void {
    const overlay = state.providerIcons.value;
    for (const provider of state.agentProviders.value) {
      provider.icon = overlay[provider.id] ?? undefined;
    }
  }

  /** 覆盖层落盘 + 盖回内存目录；图标不进 SQLite（那里存的是可启动契约）。 */
  function writeProviderIcons(icons: Record<string, string>): void {
    state.providerIcons.value = icons;
    providerIconsStorage.write({ icons });
    applyProviderIcons();
  }

  /**
   * 把持久化状态（只存 id/name/kind/command/enabled）合并回当前预设注册表。
   *
   * **为什么需要**：预设列表随版本扩充（3 → 12 个主流 ACP agent），但旧用户本地已落库的
   * providers 仍是旧快照。若直接以缓存/库覆盖，新加的 gemini/qwen/kimi… 永不可见，
   * 选择条只会显示首次装库时的那几个。
   *
   * 合并规则：以注册表为准源（决定「有哪些」「顺序」「detect/installHint 元数据」），
   * 仅把持久化的 `enabled` 覆盖回去；注册表新增的项带默认 enabled 出现。这样升级后
   * 新预设自动可见，又不丢用户已开关的偏好。
   *
   * 用户自配的后端（`custom-*` 前缀）不在注册表里，但**必须保留**——预设合并丢弃的
   * 只是「注册表已移除的残留项」，自配项是用户资产，按持久化顺序接在预设后面。
   */
  function mergeProviders(persisted: AgentProviderConfig[] | undefined): AgentProviderConfig[] {
    const byId = new Map((persisted ?? []).map((provider) => [provider.id, provider]));
    const presets = state.registry.list().map((preset) => {
      const saved = byId.get(preset.id);
      return saved ? { ...preset, enabled: saved.enabled } : preset;
    });
    const custom = (persisted ?? []).filter((provider) => isCustomAgentProvider(provider.id));
    return [...presets, ...custom];
  }

  // 缓存命中也走合并：旧缓存可能只有早期几个预设，升级后要把新增预设带出来。
  const cachedProviders = providersStorage.read()?.providers;
  state.agentProviders.value = mergeProviders(cachedProviders);
  applyProviderIcons();
  const savedPref = providerPrefStorage.read();
  const savedProvider = savedPref?.providerId
    ? state.agentProviders.value.find((provider) => provider.id === savedPref?.providerId)
    : undefined;
  state.selectedProviderId.value = savedProvider?.id ?? state.agentProviders.value[0]?.id ?? "";
  /** 恢复上次选择：偏好 ACP agent → 预选但不连接（发送时才起 runtime）；Local → 默认。 */
  state.routeToAcp.value = Boolean(savedProvider?.enabled);

  /** detect/installHint 属于前端预设、不落库；从 SQLite 读回时按 id 补回。 */
  function withPresetMeta(provider: AgentProviderConfig): AgentProviderConfig {
    const preset = state.registry.get(provider.id);
    return preset ? { ...provider, detect: preset.detect, installHint: preset.installHint } : provider;
  }

  /** 启停持久化：本地 JSON 缓存 + 桌面端 SQLite（真源），失败仅提示不阻断。 */
  function persistProviders(): void {
    providersStorage.write({ providers: state.agentProviders.value });
    if (agentsBackend.active()) {
      // 显式取字段：detect/installHint 只属于前端预设，不落库
      const rows: AgentProviderRow[] = state.agentProviders.value.map(({ id, name, kind, command, enabled }) => ({
        id,
        name,
        kind,
        command,
        enabled,
      }));
      void agentsBackend.save(rows).catch((error: unknown) => {
        console.error("[agent] 后端目录同步失败，将下次重试", error);
        notify({ kind: "error", key: "agent-provider-sync", title: t("errors.providerSyncFailed"), detail: String(error) });
      });
    }
  }

  /** 本机 PATH 探测结果（program → 探测结果）；浏览器态恒为空 → UI 不显示安装状态。 */
  const agentDetection = state.agentDetection;

  /** 探测各后端 CLI 是否安装（桌面态；失败静默 → 状态保持未知）。 */
  async function refreshAgentDetection(): Promise<void> {
    const programs = [...new Set(state.agentProviders.value.flatMap((provider) => provider.detect ?? []))];
    try {
      const probes = await agentsBackend.detect(programs);
      if (probes) agentDetection.value = Object.fromEntries(probes.map((probe) => [probe.program, probe]));
    } catch (error: unknown) {
      console.error("[agent] CLI 安装探测失败", error);
    }
  }

  /** 后端安装状态：true 已装 / false 未装 / null 未探测（未跑过探测或无探测项）。 */
  function providerInstalled(provider: AgentProviderConfig): boolean | null {
    const programs = provider.detect ?? [];
    if (programs.length === 0 || Object.keys(agentDetection.value).length === 0) return null;
    return programs.some((program) => agentDetection.value[program]?.installed === true);
  }

  /** 设置页状态文案：未装且命令走 npx → 首次启动按需下载，否则直说未安装。 */
  function providerInstallLabel(provider: AgentProviderConfig): string {
    const installed = providerInstalled(provider);
    if (installed === null) return "";
    if (installed) return "已安装";
    return provider.command.startsWith("npx") ? "首次启动下载" : "未安装";
  }

  /** 桌面态启动接管：库目录 → 覆盖（真源）；未接管 → 内置缺省/缓存首落库。 */
  state.providersHydrated = (() => {
    if (!agentsBackend.active()) return null;
    return agentsBackend
      .load()
      .then((providers) => {
        if (providers) {
          // 合并而非整体覆盖：旧库快照缺新预设时，升级后自动补齐（enabled 以库为准）。
          state.agentProviders.value = mergeProviders(providers).map(withPresetMeta);
          applyProviderIcons(); // 库里没有图标列：按真源重建目录后靠覆盖层补回
          persistProviders(); // 回写合并结果，把新增预设固化进库（自修复旧快照）
          // selected 在新目录中消失时回落首个 id（routeToAcp 状态保持，activate 再校验 enabled）
          if (!state.agentProviders.value.some((provider) => provider.id === state.selectedProviderId.value)) {
            state.selectedProviderId.value = state.agentProviders.value[0]?.id ?? "";
          }
          if (!state.routeToAcp.value && !savedProvider?.enabled && state.selectedProviderId.value === "") {
            state.selectedProviderId.value = state.agentProviders.value[0]?.id ?? "";
          }
        } else {
          persistProviders(); // 首启：内置缺省成为库真源
        }
      })
      .catch((error: unknown) => {
        console.error("[agent] 后端目录加载失败，沿用内置缺省", error);
        notify({ kind: "error", key: "agent-provider-load", title: t("errors.providerSyncFailed"), detail: String(error) });
      });
  })();

  /** 启停 ACP 后端：禁用当前选中且正在 ACP 路由时自动切回 Local LLM。 */
  async function setAgentProviderEnabled(id: string, enabled: boolean): Promise<void> {
    const provider = state.agentProviders.value.find((candidate) => candidate.id === id);
    if (!provider || provider.enabled === enabled) return;
    provider.enabled = enabled;
    persistProviders();
    if (!enabled && id === state.selectedProviderId.value && state.routeToAcp.value) {
      await switchToLocalLlm(); // 停用当前后端：完整清理 ACP 状态回 Local
    }
  }

  /** 改任一后端的展示图标（含预设：图标不影响可启动契约，故不套 updateAgentProvider 的预设禁令）。 */
  function setAgentProviderIcon(id: string, icon: string | null): void {
    if (!state.agentProviders.value.some((provider) => provider.id === id)) return;
    const next = { ...state.providerIcons.value };
    if (icon) next[id] = icon;
    else delete next[id];
    writeProviderIcons(next);
  }

  /** 把图标写进覆盖层（空/undefined = 用兜底图标，不占条目）。 */
  function recordProviderIcon(id: string, icon?: string): void {
    if (!icon) return;
    writeProviderIcons({ ...state.providerIcons.value, [id]: icon });
  }

  /** 新增用户自配 ACP 后端（名称 + 启动命令 + 可选图标）；返回错误文案（null = 成功）。 */
  function addAgentProvider(name: string, command: string, icon?: string): string | null {
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (!trimmedName) return t("errors.agentProviderNameRequired");
    if (!trimmedCommand) return t("errors.agentProviderCommandRequired");
    const id = newCustomProviderId();
    state.agentProviders.value.push({
      id,
      name: trimmedName,
      kind: "acp",
      command: trimmedCommand,
      enabled: true,
      detect: detectProgramOf(trimmedCommand),
    });
    recordProviderIcon(id, icon);
    persistProviders();
    void refreshAgentDetection();
    return null;
  }

  /**
   * 编辑用户自配 ACP 后端（名称 / 命令 / 图标）。预设项不可改：合并流程会用注册表元数据
   * 覆盖回去，改了也不持久，故直接拒绝（图标单独经 setAgentProviderIcon 改）。
   */
  function updateAgentProvider(id: string, name: string, command: string, icon?: string): string | null {
    const provider = state.agentProviders.value.find((candidate) => candidate.id === id);
    if (!provider || !isCustomAgentProvider(id)) return t("errors.agentProviderNotEditable");
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (!trimmedName) return t("errors.agentProviderNameRequired");
    if (!trimmedCommand) return t("errors.agentProviderCommandRequired");
    provider.name = trimmedName;
    provider.command = trimmedCommand;
    provider.detect = detectProgramOf(trimmedCommand);
    recordProviderIcon(id, icon);
    persistProviders();
    void refreshAgentDetection();
    return null;
  }

  /** 删除用户自配 ACP 后端；删的是当前选中项时回落选择，正在 ACP 路由则先切回 Local。 */
  async function removeAgentProvider(id: string): Promise<string | null> {
    const provider = state.agentProviders.value.find((candidate) => candidate.id === id);
    if (!provider) return t("errors.acpNotSelected");
    if (!isCustomAgentProvider(id)) return t("errors.agentProviderNotEditable");
    if (id === state.selectedProviderId.value && state.routeToAcp.value) {
      await switchToLocalLlm();
    }
    state.agentProviders.value = state.agentProviders.value.filter((candidate) => candidate.id !== id);
    const next = { ...state.providerIcons.value };
    delete next[id]; // 连带清图标映射：后端都没了，留着只会让 id 空间漏
    writeProviderIcons(next);
    if (id === state.selectedProviderId.value) {
      state.selectedProviderId.value = state.agentProviders.value.find((candidate) => candidate.enabled)?.id ?? "";
    }
    persistProviders();
    return null;
  }

  /** 切换首页 ACP CLI 入口。切换已有连接时先释放旧 agent，避免跨 provider 复用 session。 */
  async function activateAcpProvider(id: string): Promise<string | null> {
    const provider = state.agentProviders.value.find((candidate) => candidate.id === id);
    if (!provider) return t("errors.acpNotSelected");
    if (!provider.enabled) return t("errors.providerNotEnabled", { name: provider.name });
    if (state.selectedProviderId.value !== id && state.acpHandle.value !== null) {
      try {
        await acp.stop(state.acpHandle.value);
      } catch (error) {
        return t("errors.stopCurrentFailed", { detail: String(error) });
      }
      state.acpConnected.value = false;
      state.acpHandle.value = null;
      state.acpSessionId.value = null;
      state.locals.acpSessionThreadId = null;
      state.acpConfigOptions.value = [];
      runtime().dismissPendingPermission();
      state.acpStreamId.value = null;
      state.chat.runningSessionId = null;
    }
    state.selectedProviderId.value = id;
    state.routeToAcp.value = true;
    providerPrefStorage.write({ providerId: id });
    // 后端选择也按工作区记忆（回放时 replayingConfig 无关：providerId 幂等）
    if (state.workspace.activeWorkspaceId) state.workspace.setAgentConfig(state.workspace.activeWorkspaceId, { providerId: id });
    // 选中即建会话：configOptions（模型 / 思考强度）只有 session/new 之后才有值，
    // 否则选择器要等到首次发送才出现。连接失败不阻塞选择（发送时会重试并落文案）；
    // 失败文案原样返回，调用方（AgentProviderBar）就地展示而非静默吞掉。
    return await runtime().connectAcp();
  }

  /** 回放工作区记忆配置期间置真，抑制 setAcpConfig 的自反写入（对齐原闭包变量）。 */
  const replayingConfig = state.locals;

  /**
   * 应用某工作区记住的 ACP 后端与会话配置。
   *
   * 无记录时**不动当前状态**（用户可能刚在别处选好后端，切个工作区不该被重置）。
   */
  async function applyWorkspaceAgentConfig(workspaceId: string | null): Promise<void> {
    const remembered = state.workspace.agentConfigOf(workspaceId);
    if (!remembered) return;
    if (remembered.providerId === null) {
      if (state.routeToAcp.value) await switchToLocalLlm();
      return;
    }
    if (remembered.providerId && (remembered.providerId !== state.selectedProviderId.value || !state.routeToAcp.value)) {
      const failure = await activateAcpProvider(remembered.providerId);
      if (failure) return; // 连不上就停在错误态，别再拿旧 handle 回放配置
    }
    const values = remembered.configValues;
    if (!values || state.acpHandle.value === null) return;
    replayingConfig.replayingConfig = true;
    try {
      for (const [configId, value] of Object.entries(values)) {
        const option = state.acpConfigOptions.value.find((candidate) => candidate.id === configId && candidate.type === "select");
        if (option) await runtime().setAcpConfig(configId, value);
      }
    } finally {
      replayingConfig.replayingConfig = false;
    }
  }

  // 切工作区即换「这个项目的干活方式」；immediate 关掉，避免启动就抢着建连接。
  watch(() => state.workspace.activeWorkspaceId, applyWorkspaceAgentConfig);

  function selectProvider(id: string): void {
    state.selectedProviderId.value = id;
  }

  function toggleRouteToAcp(): void {
    state.routeToAcp.value = !state.routeToAcp.value;
  }

  /** 切回本地 LLM 管线（关闭 ACP 路由；若已连接 agent 则释放）。 */
  async function switchToLocalLlm(): Promise<void> {
    state.routeToAcp.value = false;
    providerPrefStorage.write({ providerId: null });
    if (state.workspace.activeWorkspaceId) state.workspace.setAgentConfig(state.workspace.activeWorkspaceId, { providerId: null });
    if (state.acpHandle.value !== null) {
      try {
        await acp.stop(state.acpHandle.value);
      } catch {
        // 释放失败不阻塞切换；下次 startAcpSession 会重建。
      }
      state.acpConnected.value = false;
      state.acpHandle.value = null;
      state.acpSessionId.value = null;
      state.locals.acpSessionThreadId = null;
      state.acpConfigOptions.value = [];
      state.acpImageSupport.value = null;
      runtime().dismissPendingPermission();
      state.acpStreamId.value = null;
      state.chat.runningSessionId = null;
      state.activeTurnId.value = null;
      state.turnStartedAtMs.value = null;
      state.acpStatus.value = "disconnected";
    }
  }

  return {
    refreshAgentDetection,
    providerInstalled,
    providerInstallLabel,
    setAgentProviderEnabled,
    setAgentProviderIcon,
    addAgentProvider,
    updateAgentProvider,
    removeAgentProvider,
    activateAcpProvider,
    applyWorkspaceAgentConfig,
    selectProvider,
    toggleRouteToAcp,
    switchToLocalLlm,
  };
}
