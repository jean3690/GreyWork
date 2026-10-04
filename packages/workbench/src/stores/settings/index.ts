import { createJsonStorage } from "@greywork/core";
import type { McpServerConfig } from "@greywork/acp";
import {
  DEFAULT_MODEL_PROVIDERS,
  DEFAULT_OFFICE_PROVIDERS,
  type ModelProviderConfig,
  type OfficeProviderConfig,
  type ServiceProviderConfig,
} from "@greywork/shell";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { settingsBackend } from "../../lib/settings-backend";
import { applyAppearance as applyAppearanceToDom } from "../../lib/theme";
import { notify } from "../notice";
import { i18n, type AppLocale } from "../../i18n";
import {
  DEFAULT_CHANNEL_PREFS,
  DEFAULT_LOCAL_AI,
  DEFAULT_MCP_SERVERS,
  DEFAULT_REMOTE_ASSIST,
  DEFAULT_SKILL_SOURCES,
  MAX_PARALLEL_RANGE,
  type ChannelId,
  type ChannelPrefs,
  type ColorMode,
  type FontSize,
  type LocalAiPrefs,
  type McpServerEntry,
  type PermTier,
  type Radius,
  type RemoteAssistPrefs,
  type RunMode,
  type SandboxMode,
  type SavedSettings,
  type SkillSourceEntry,
  type ThemeId,
} from "./types";
import {
  COLOR_MODE_VALUES,
  FONT_SIZE_VALUES,
  MCP_TRANSPORTS,
  RADIUS_VALUES,
  RUN_MODE_VALUES,
  SANDBOX_MODE_VALUES,
  SKILL_SOURCE_TYPES,
  THEME_VALUES,
  normalizeAcpConfigValues,
  normalizeHeaders,
  normalizeLocalAi,
  normalizeMaxTokens,
  normalizeReasoningEffort,
  normalizeServiceProvider,
  normalizeTemperature,
} from "./normalize";

const t = i18n.global.t;

// 类型 / 常量 / 默认值从 `./types` 统一再导出：外部仍从 `@/stores/settings` 取，
// 与拆分前完全一致（设置页、各 store 的 import 路径不用改）。
export * from "./types";

const settingsStorage = createJsonStorage<SavedSettings>(
  "greywork.settings",
  (value): value is SavedSettings => typeof value === "object" && value !== null && !Array.isArray(value),
);

/** 全局设置：权限档位 / 计划模式 / token 快照 / 供应商芯片 / MCP 服务器声明。 */
export const useSettingsStore = defineStore("settings", () => {
  const permissionTier = ref<PermTier>("workspace");
  /** 默认自动启用可用的宿主沙箱；off 只能由用户显式选择。 */
  const sandboxMode = ref<SandboxMode>("auto");
  /** 多智能体编排并发度（同时跑的回合上限）。默认 2，与既有并行编排一致。 */
  const maxParallel = ref(2);
  /** 关闭到托盘（默认开）：点关闭按钮只隐藏窗口，托盘「退出应用」才真正退出。 */
  const closeToTray = ref(true);
  /**
   * 会话内临时降级到只读：**刻意不持久化**。
   *
   * 语义是「Full 会话内一键降 ReadOnly 跑完再升」——重启后应回到用户的基线档位，
   * 把它写进快照会让临时动作变成长期状态，正是这一项要避免的事。
   */
  const tempReadOnly = ref(false);
  /** 实际下发给宿主的档位：临时降级期间一律只读，否则用基线档位。 */
  const effectivePermissionTier = computed<PermTier>(() => (tempReadOnly.value ? "read-only" : permissionTier.value));
  /**
   * 运行模式：local 直接在工作区执行；worktree 由宿主派生隔离快照（见 lib/workspace-dir.ts
   * 的 isolateForRun）；cloud 尚无宿主实现，选中不产生任何效果。
   */
  const runMode = ref<RunMode>("local");
  /** ACP 会话工作区目录（空 = 宿主私有 ~/.greyWork；宿主只接受已授权目录）。 */
  const workspaceDir = ref("");
  const planMode = ref(false);
  /** 主题配色与明暗模式正交：同一主题都提供浅色和深色。 */
  const theme = ref<ThemeId>("greywork");
  const colorMode = ref<ColorMode>("dark");
  /** 界面字号以整体 UI 缩放实现，固定像素字号与控件命中区一起保持比例。 */
  const fontSize = ref<FontSize>("medium");
  /** 界面圆角档位，驱动 theme/base.css 的 `--gw-radius-scale`。 */
  const radius = ref<Radius>("small");
  /** 界面语言（i18n 实例初值同源于此 localStorage；切换经外壳 watch → setLocale）。 */
  const locale = ref<AppLocale>("zh-CN");
  const selectedModelProviderId = ref<string | null>(null);
  /** tokens.css 派生只读快照（外壳 bootstrap 时填充；不提供写接口）。 */
  const modelProviders = ref<ModelProviderConfig[]>(
    DEFAULT_MODEL_PROVIDERS.map((provider) => ({
      ...provider,
      reasoningEffort: provider.reasoningEffort ?? "auto",
    })),
  );
  /** 已声明的 MCP 服务器（含未启用项）。 */
  const mcpServers = ref<McpServerEntry[]>(DEFAULT_MCP_SERVERS.map((server) => ({ ...server })));
  /**
   * 第三方服务配置。默认只有 office 族的预设（全部 `enabled: false`）——
   * 没启用 = 预览走本地 viewer，行为与加这个功能之前完全一致。
   */
  const serviceProviders = ref<ServiceProviderConfig[]>(DEFAULT_OFFICE_PROVIDERS.map((provider) => ({ ...provider })));
  /** 云端 Office 选中的服务商 id；null = 取第一个可用的。 */
  const selectedOfficeProviderId = ref<string | null>(null);
  /** 本地 AI（RAG / STT）配置；默认全关。 */
  const localAi = ref<LocalAiPrefs>(normalizeLocalAi(DEFAULT_LOCAL_AI));
  /** office 族配置（设置页分组与预览决策都只关心这一族）。 */
  const officeProviders = computed<OfficeProviderConfig[]>(() =>
    serviceProviders.value.filter((provider): provider is OfficeProviderConfig => provider.family === "office"),
  );
  /** 用户自定义技能市场源。 */
  const skillSources = ref<SkillSourceEntry[]>(DEFAULT_SKILL_SOURCES.map((source) => ({ ...source })));
  /** 远程助手 · 各通道开关（登录凭证在宿主，不在快照里）。 */
  const remoteAssist = ref<RemoteAssistPrefs>({
    replyMode: DEFAULT_REMOTE_ASSIST.replyMode,
    replyProviderId: DEFAULT_REMOTE_ASSIST.replyProviderId,
    acpConfigValues: {},
    channels: {
      wechat: { ...DEFAULT_CHANNEL_PREFS },
      dingtalk: { ...DEFAULT_CHANNEL_PREFS },
      feishu: { ...DEFAULT_CHANNEL_PREFS },
      telegram: { ...DEFAULT_CHANNEL_PREFS },
      qq: { ...DEFAULT_CHANNEL_PREFS },
      discord: { ...DEFAULT_CHANNEL_PREFS },
      wecom: { ...DEFAULT_CHANNEL_PREFS },
    },
  });
  /** 下发给 agent 的那一批：只取启用项，并剥掉 id/enabled 这类纯本地字段。 */
  const enabledMcpServers = computed<McpServerConfig[]>(() =>
    mcpServers.value.filter((server) => server.enabled).map(({ id: _id, enabled: _enabled, ...config }) => config),
  );

  /** 校验并应用一份持久化快照（localStorage / SQLite 共用同一校验面）。 */
  const PERM_TIER_VALUES: Record<PermTier, true> = { "read-only": true, workspace: true, full: true };

  /**
   * 同步把当前外观写到根节点并广播。设置控件调用此入口后，背景色在同一事件中生效；
   * Shell 的 watch 仍负责跟随系统模式变化，但不再是用户点击后的唯一应用路径。
   *
   * 落地点只有 lib/theme 的 applyAppearance 一处（写 data-* + 发 APPEARANCE_EVENT），
   * system 的解析也在那里，避免两处各写一份解析规则。
   */
  function applyAppearance(): void {
    applyAppearanceToDom({ palette: theme.value, colorMode: colorMode.value, fontSize: fontSize.value, radius: radius.value });
  }

  function setTheme(value: ThemeId): void {
    theme.value = value;
    applyAppearance();
    persist();
  }

  function setColorMode(value: ColorMode): void {
    colorMode.value = value;
    applyAppearance();
    persist();
  }

  function setFontSize(value: FontSize): void {
    fontSize.value = value;
    applyAppearance();
    persist();
  }

  function setRadius(value: Radius): void {
    radius.value = value;
    applyAppearance();
    persist();
  }

  /** 运行模式变更即落盘：隔离档位要跨重启保持，否则用户下次开场又回到 local。 */
  function setRunMode(value: RunMode): void {
    runMode.value = value;
    persist();
  }

  /** 关闭行为变更即落盘；宿主侧由 lib/tray-bridge 的 watch 同步（本 store 不直接碰 IPC）。 */
  function setCloseToTray(value: boolean): void {
    closeToTray.value = value;
    persist();
  }

  function applySaved(saved: SavedSettings | null | undefined): void {
    if (!saved) return;
    if (saved.permissionTier && PERM_TIER_VALUES[saved.permissionTier]) permissionTier.value = saved.permissionTier;
    // 无字段（旧快照）与非法值都迁移到 auto；绝不因损坏配置回落为直启。
    sandboxMode.value = saved.sandboxMode && SANDBOX_MODE_VALUES[saved.sandboxMode] ? saved.sandboxMode : "auto";
    // 运行模式：旧快照缺字段或非法值一律回落 local —— 绝不因损坏配置悄悄进隔离。
    runMode.value = saved.runMode && RUN_MODE_VALUES[saved.runMode] ? saved.runMode : "local";
    if (typeof saved.workspaceDir === "string") workspaceDir.value = saved.workspaceDir;
    // 并发度：仅整数且落在区间内才接受；越界 / 非法值静默回落默认 2（不写通知）。
    if (Number.isInteger(saved.maxParallel)) {
      const n = saved.maxParallel as number;
      maxParallel.value = n >= MAX_PARALLEL_RANGE.min && n <= MAX_PARALLEL_RANGE.max ? n : 2;
    }
    // 缺字段（旧快照）保持默认「关闭到托盘」；只有显式 false 才改成关闭即退出。
    if (typeof saved.closeToTray === "boolean") closeToTray.value = saved.closeToTray;
    if (saved.theme && THEME_VALUES[saved.theme as ThemeId]) theme.value = saved.theme as ThemeId;
    if (saved.colorMode && COLOR_MODE_VALUES[saved.colorMode]) colorMode.value = saved.colorMode;
    // v0.1 兼容：旧 theme 字段承载明暗模式；读入后下一次 persist 会写成新结构。
    else if (saved.theme && COLOR_MODE_VALUES[saved.theme as ColorMode]) colorMode.value = saved.theme as ColorMode;
    if (saved.fontSize && FONT_SIZE_VALUES[saved.fontSize]) fontSize.value = saved.fontSize;
    if (saved.radius && RADIUS_VALUES[saved.radius]) radius.value = saved.radius;
    if (saved.locale === "zh-CN" || saved.locale === "en-US") locale.value = saved.locale;
    if (typeof saved.selectedModelProviderId === "string" || saved.selectedModelProviderId === null) {
      selectedModelProviderId.value = saved.selectedModelProviderId;
    }
    if (Array.isArray(saved.modelProviders)) {
      const valid = saved.modelProviders.filter(
        (provider) =>
          provider &&
          typeof provider.id === "string" &&
          typeof provider.name === "string" &&
          typeof provider.model === "string" &&
          typeof provider.enabled === "boolean",
      );
      if (valid.length) {
        modelProviders.value = valid.map((provider) => ({
          ...provider,
          reasoningEffort: normalizeReasoningEffort(provider.reasoningEffort),
          headers: normalizeHeaders(provider.headers),
          temperature: normalizeTemperature(provider.temperature),
          maxTokens: normalizeMaxTokens(provider.maxTokens),
        }));
      }
    }
    if (Array.isArray(saved.mcpServers)) {
      mcpServers.value = saved.mcpServers
        .filter((server) => server && typeof server.id === "string" && typeof server.name === "string" && MCP_TRANSPORTS[server.transport])
        .map((server) => ({ ...server, enabled: server.enabled === true }));
    }
    // 服务配置：逐条归一化，形状不合法的整条丢弃（不是整表丢弃 —— 一条坏数据不该让其余全失效）。
    // 空数组**不覆盖默认值**，与 skillSources 的处理相反：预设 office 服务商是用户填配方的起点，
    // 清空后应当还能在设置页看到它们，而不是「配置页空得无从下手，只能手写 JSON」。
    if (Array.isArray(saved.serviceProviders)) {
      const valid = saved.serviceProviders
        .map(normalizeServiceProvider)
        .filter((provider): provider is ServiceProviderConfig => provider !== null);
      if (valid.length) serviceProviders.value = valid;
    }
    if (typeof saved.selectedOfficeProviderId === "string" || saved.selectedOfficeProviderId === null) {
      selectedOfficeProviderId.value = saved.selectedOfficeProviderId;
    }
    // 本地 AI：缺字段落默认（旧快照读入后就是「全关」）。
    localAi.value = normalizeLocalAi(saved.localAi);
    if (Array.isArray(saved.skillSources)) {
      skillSources.value = saved.skillSources
        .filter((source) => source && typeof source.id === "string" && typeof source.label === "string" && SKILL_SOURCE_TYPES[source.type])
        .map((source) => ({ ...source, enabled: source.enabled === true }));
      if (skillSources.value.length === 0) skillSources.value = DEFAULT_SKILL_SOURCES.map((source) => ({ ...source }));
    }
    // 通道偏好：缺省即启用（「自动连接 / 自动回复」是通道常态），只有显式 false 才关；
    // 「答复其他联系人」相反 —— 只有显式 true 才放行。
    const normalizeChannel = (saved: Partial<ChannelPrefs> | undefined): ChannelPrefs => ({
      autoConnect: saved?.autoConnect !== false,
      autoReply: saved?.autoReply !== false,
      allowOtherSenders: saved?.allowOtherSenders === true,
    });
    const remote = saved.remoteAssist;
    // v1 快照把微信开关与回复后端平铺在 wechatChannel 下：读入时迁移进新结构。
    const legacy = saved.wechatChannel;
    if (remote || legacy) {
      const replyMode = remote?.replyMode ?? legacy?.replyMode;
      const replyProviderId = remote?.replyProviderId ?? legacy?.replyProviderId;
      remoteAssist.value = {
        replyMode: replyMode === "acp" ? "acp" : "llm",
        replyProviderId: typeof replyProviderId === "string" ? replyProviderId : null,
        acpConfigValues: normalizeAcpConfigValues(remote?.acpConfigValues),
        channels: {
          wechat: normalizeChannel(remote?.channels?.wechat ?? legacy),
          dingtalk: normalizeChannel(remote?.channels?.dingtalk),
          feishu: normalizeChannel(remote?.channels?.feishu),
          telegram: normalizeChannel(remote?.channels?.telegram),
          qq: normalizeChannel(remote?.channels?.qq),
          discord: normalizeChannel(remote?.channels?.discord),
          wecom: normalizeChannel(remote?.channels?.wecom),
        },
      };
    }
    applyAppearance();
  }

  function persist(): void {
    const snapshot: SavedSettings = {
      theme: theme.value,
      colorMode: colorMode.value,
      fontSize: fontSize.value,
      radius: radius.value,
      locale: locale.value,
      selectedModelProviderId: selectedModelProviderId.value,
      modelProviders: modelProviders.value,
      permissionTier: permissionTier.value,
      sandboxMode: sandboxMode.value,
      runMode: runMode.value,
      workspaceDir: workspaceDir.value,
      mcpServers: mcpServers.value,
      skillSources: skillSources.value,
      serviceProviders: serviceProviders.value,
      selectedOfficeProviderId: selectedOfficeProviderId.value,
      localAi: { rag: { ...localAi.value.rag }, stt: { ...localAi.value.stt } },
      maxParallel: maxParallel.value,
      closeToTray: closeToTray.value,
      remoteAssist: {
        replyMode: remoteAssist.value.replyMode,
        replyProviderId: remoteAssist.value.replyProviderId,
        acpConfigValues: { ...remoteAssist.value.acpConfigValues },
        channels: {
          wechat: { ...remoteAssist.value.channels.wechat },
          dingtalk: { ...remoteAssist.value.channels.dingtalk },
          feishu: { ...remoteAssist.value.channels.feishu },
          telegram: { ...remoteAssist.value.channels.telegram },
          qq: { ...remoteAssist.value.channels.qq },
          discord: { ...remoteAssist.value.channels.discord },
          wecom: { ...remoteAssist.value.channels.wecom },
        },
      },
    };
    settingsStorage.write(snapshot);
    if (settingsBackend.active()) {
      // 后端真源同步：失败不回滚内存（下次 persist 自愈）。
      void settingsBackend.save(snapshot as Record<string, unknown>).catch((error: unknown) => {
        console.error("[settings] SQLite 同步失败，将下次重试", error);
        notify({ kind: "error", key: "settings-sync", title: t("errors.settingsSyncFailed"), detail: String(error) });
      });
    }
  }

  applySaved(settingsStorage.read());

  /** 桌面态启动接管：库已接管 → 库内容覆盖本地缓存；未接管 → 当前默认值首落库。 */
  const backendHydratePromise = (() => {
    if (!settingsBackend.active()) return null;
    return settingsBackend
      .load()
      .then((saved) => {
        if (saved) {
          applySaved(saved as SavedSettings);
          persist(); // 缓存与真源对齐（幂等回写）
        } else {
          persist(); // 首启：默认/缓存值成为库真源
        }
      })
      .catch((error: unknown) => {
        console.error("[settings] SQLite 加载失败，沿用本地缓存", error);
        notify({ kind: "warning", key: "settings-load", title: t("errors.settingsSyncFailed"), detail: String(error) });
      });
  })();

  /** 新增或按 id 覆盖一台 MCP 服务器。 */
  function upsertMcpServer(entry: McpServerEntry): void {
    const index = mcpServers.value.findIndex((server) => server.id === entry.id);
    if (index >= 0) mcpServers.value[index] = { ...entry };
    else mcpServers.value.push({ ...entry });
    persist();
  }

  function removeMcpServer(id: string): void {
    mcpServers.value = mcpServers.value.filter((server) => server.id !== id);
    persist();
  }

  /** 整表覆盖（JSON 导入）：外部快照 → 归一化后整体替换。 */
  function replaceMcpServers(entries: McpServerEntry[]): void {
    mcpServers.value = entries.map((server) => ({ ...server, enabled: server.enabled === true }));
    persist();
  }

  /* ===== 模型供应商管理（设置页编辑面） ===== */
  /** 选中即持久化（此前点选直接写 ref，重启即丢）。 */
  function selectModelProvider(id: string | null): void {
    selectedModelProviderId.value = id;
    persist();
  }

  /** 新增或整体覆盖一台模型供应商；写入前归一化 reasoningEffort 与采样参数。 */
  function upsertModelProvider(provider: ModelProviderConfig): void {
    const normalized = {
      ...provider,
      reasoningEffort: normalizeReasoningEffort(provider.reasoningEffort),
      temperature: normalizeTemperature(provider.temperature),
      maxTokens: normalizeMaxTokens(provider.maxTokens),
    };
    const index = modelProviders.value.findIndex((candidate) => candidate.id === provider.id);
    if (index >= 0) modelProviders.value[index] = normalized;
    else modelProviders.value.push(normalized);
    persist();
  }

  /** 恢复出厂默认供应商清单（误删/改坏后的逃生门）。 */
  function resetModelProviders(): void {
    modelProviders.value = DEFAULT_MODEL_PROVIDERS.map((provider) => ({ ...provider, reasoningEffort: "auto" as const }));
    selectedModelProviderId.value = null;
    persist();
  }

  /** 删除自定义供应商；删的是当前选中项则回落空选（Local 默认路径）。 */
  function removeModelProvider(id: string): void {
    modelProviders.value = modelProviders.value.filter((candidate) => candidate.id !== id);
    if (selectedModelProviderId.value === id) selectedModelProviderId.value = null;
    persist();
  }

  /* ===== 第三方服务配置（设置页「服务」分区） ===== */

  /** 新增或按 id 整体覆盖一条服务配置；写前归一化，形状不合法直接拒收（不落盘脏数据）。 */
  function upsertServiceProvider(provider: ServiceProviderConfig): boolean {
    const normalized = normalizeServiceProvider(provider);
    if (!normalized) return false;
    const index = serviceProviders.value.findIndex((candidate) => candidate.id === normalized.id);
    if (index >= 0) serviceProviders.value[index] = normalized;
    else serviceProviders.value.push(normalized);
    persist();
    return true;
  }

  /** 删除一条服务配置；删的是当前选中的 office 服务商则回落空选。 */
  function removeServiceProvider(id: string): void {
    serviceProviders.value = serviceProviders.value.filter((candidate) => candidate.id !== id);
    if (selectedOfficeProviderId.value === id) selectedOfficeProviderId.value = null;
    persist();
  }

  /** 恢复 office 族预设（误删/改坏后的逃生门）；只重置这一族，不动其它族。 */
  function resetServiceProviders(): void {
    serviceProviders.value = [
      ...serviceProviders.value.filter((provider) => provider.family !== "office"),
      ...DEFAULT_OFFICE_PROVIDERS.map((provider) => ({ ...provider })),
    ];
    selectedOfficeProviderId.value = null;
    persist();
  }

  /** 选中云端 Office 服务商；null = 用第一个「已启用且填了配方」的。 */
  function selectOfficeProvider(id: string | null): void {
    selectedOfficeProviderId.value = id;
    persist();
  }

  /** 启用/停用。停用后不再随新会话下发；已在跑的会话不受影响（声明在建会话时定格）。 */
  function setMcpServerEnabled(id: string, enabled: boolean): void {
    const server = mcpServers.value.find((candidate) => candidate.id === id);
    if (!server) return;
    server.enabled = enabled;
    persist();
  }

  /** 批量启停只持久化一次；已建立会话仍保持建会话时的声明快照。 */
  function setAllMcpServersEnabled(enabled: boolean): void {
    if (mcpServers.value.every((server) => server.enabled === enabled)) return;
    mcpServers.value = mcpServers.value.map((server) => ({ ...server, enabled }));
    persist();
  }

  /** 恢复出厂默认 MCP 服务器（误删/改坏后的逃生门）。 */
  function resetMcpServers(): void {
    mcpServers.value = DEFAULT_MCP_SERVERS.map((server) => ({ ...server }));
    persist();
  }

  /* ===== 技能市场源管理 ===== */

  /** 新增或按 id 覆盖一个技能市场源。 */
  function upsertSkillSource(entry: SkillSourceEntry): void {
    const index = skillSources.value.findIndex((source) => source.id === entry.id);
    if (index >= 0) skillSources.value[index] = { ...entry };
    else skillSources.value.push({ ...entry });
    persist();
  }

  function removeSkillSource(id: string): void {
    skillSources.value = skillSources.value.filter((source) => source.id !== id);
    persist();
  }

  /** 启用/停用一个技能市场源（停用后搜索不再包含该源）。 */
  function setSkillSourceEnabled(id: string, enabled: boolean): void {
    const source = skillSources.value.find((candidate) => candidate.id === id);
    if (!source) return;
    source.enabled = enabled;
    persist();
  }

  /** 恢复内置默认技能源（去掉用户自定义源）。 */
  function resetSkillSources(): void {
    skillSources.value = DEFAULT_SKILL_SOURCES.map((source) => ({ ...source }));
    persist();
  }

  /** 更新某条通道的行为开关（部分字段）；落盘一次。 */
  function setChannelPrefs(channel: ChannelId, patch: Partial<ChannelPrefs>): void {
    remoteAssist.value = {
      ...remoteAssist.value,
      channels: { ...remoteAssist.value.channels, [channel]: { ...remoteAssist.value.channels[channel], ...patch } },
    };
    persist();
  }

  /** 更新共用回复设置（后端档位、选定的 ACP 后端与细粒度配置覆盖）。 */
  function setRemoteAssist(patch: Partial<Pick<RemoteAssistPrefs, "replyMode" | "replyProviderId" | "acpConfigValues">>): void {
    remoteAssist.value = { ...remoteAssist.value, ...patch };
    persist();
  }

  /** 更新本地 RAG 配置（局部字段）；落盘一次。 */
  function setLocalAiRag(patch: Partial<LocalAiPrefs["rag"]>): void {
    localAi.value = { ...localAi.value, rag: { ...localAi.value.rag, ...patch } };
    persist();
  }

  /** 更新本地 STT 配置（局部字段）；落盘一次。 */
  function setLocalAiStt(patch: Partial<LocalAiPrefs["stt"]>): void {
    localAi.value = { ...localAi.value, stt: { ...localAi.value.stt, ...patch } };
    persist();
  }

  /** 单个细粒度配置项的写入/清除（value 传空串 = 删掉覆盖，回到「跟随当前会话」）。 */
  function setRemoteAcpConfigValue(configId: string, value: string): void {
    const next = { ...remoteAssist.value.acpConfigValues };
    if (value === "") delete next[configId];
    else next[configId] = value;
    setRemoteAssist({ acpConfigValues: next });
  }

  return {
    permissionTier,
    sandboxMode,
    maxParallel,
    closeToTray,
    setCloseToTray,
    tempReadOnly,
    effectivePermissionTier,
    runMode,
    workspaceDir,
    planMode,
    theme,
    colorMode,
    fontSize,
    applyAppearance,
    setTheme,
    setColorMode,
    setFontSize,
    radius,
    setRadius,
    setRunMode,
    locale,
    selectedModelProviderId,
    modelProviders,
    mcpServers,
    enabledMcpServers,
    upsertMcpServer,
    removeMcpServer,
    replaceMcpServers,
    setMcpServerEnabled,
    setAllMcpServersEnabled,
    resetMcpServers,
    skillSources,
    upsertSkillSource,
    removeSkillSource,
    setSkillSourceEnabled,
    resetSkillSources,
    remoteAssist,
    setChannelPrefs,
    setRemoteAssist,
    setRemoteAcpConfigValue,
    selectModelProvider,
    upsertModelProvider,
    removeModelProvider,
    resetModelProviders,
    serviceProviders,
    officeProviders,
    selectedOfficeProviderId,
    upsertServiceProvider,
    removeServiceProvider,
    resetServiceProviders,
    selectOfficeProvider,
    localAi,
    setLocalAiRag,
    setLocalAiStt,
    persist,
    /** 桌面态启动接管完成信号（null = 浏览器态无后端）；await 后库内容已就位。 */
    hydrated: backendHydratePromise,
  };
});
