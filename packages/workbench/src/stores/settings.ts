import { createJsonStorage } from "@greywork/core";
import type { McpServerConfig } from "@greywork/acp";
import { DEFAULT_MODEL_PROVIDERS, type ModelProviderConfig, type ReasoningEffort } from "@greywork/shell";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { settingsBackend } from "../lib/settings-backend";
import { applyAppearance as applyAppearanceToDom } from "../lib/theme";
import { notify } from "./notice";
import { i18n } from "../i18n";

const t = i18n.global.t;
import type { AppLocale } from "../i18n";

export type PermTier = "read-only" | "workspace" | "full";

/** 推理等级合法值（shell REASONING_EFFORTS 的 value 集）。 */
const REASONING_EFFORT_VALUES: Record<string, true> = { auto: true, low: true, medium: true, high: true, max: true };

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_VALUES[value] ? (value as ReasoningEffort) : "auto";
}

/** 权限三档（Read Only / Workspace / Full Access）。label/desc 为 i18n key，渲染处 t() 转译。 */
export const PERMISSION_TIERS = [
  { value: "read-only", label: "settings.permissions.readOnly.label", desc: "settings.permissions.readOnly.desc" },
  { value: "workspace", label: "settings.permissions.workspace.label", desc: "settings.permissions.workspace.desc" },
  { value: "full", label: "settings.permissions.full.label", desc: "settings.permissions.full.desc" },
] as const;

export const PERM_LABELS: Record<PermTier, string> = {
  "read-only": "settings.permissions.readOnly.label",
  workspace: "settings.permissions.workspace.label",
  full: "settings.permissions.full.label",
};

/** 沙盒策略。auto 在 Linux bwrap 可用时启用 fs，否则宿主显式记录未隔离告警。 */
export type SandboxMode = "auto" | "off" | "fs" | "full";
export const SANDBOX_MODES: { value: SandboxMode; label: string; desc: string }[] = [
  { value: "auto", label: "settings.sandbox.auto.label", desc: "settings.sandbox.auto.desc" },
  { value: "off", label: "settings.sandbox.off.label", desc: "settings.sandbox.off.desc" },
  { value: "fs", label: "settings.sandbox.fs.label", desc: "settings.sandbox.fs.desc" },
  { value: "full", label: "settings.sandbox.full.label", desc: "settings.sandbox.full.desc" },
];

const SANDBOX_MODE_VALUES: Record<SandboxMode, true> = { auto: true, off: true, fs: true, full: true };

/** 编排并发度合法区间（含端点）。 */
export const MAX_PARALLEL_RANGE = { min: 1, max: 8 } as const;

/** 权限档位 → 建议沙盒策略。默认一律 auto；放行网络必须由用户显式选择 full。 */
export function recommendedSandboxMode(_tier: PermTier): SandboxMode {
  return "auto";
}

export type RunMode = "local" | "worktree" | "cloud";
export type ThemeId = "greywork" | "night-blue" | "night-green" | "github" | "fox";
export type ColorMode = "dark" | "light" | "system";
export type FontSize = "small" | "medium" | "large";

/** label 是专有名词（不翻译），description 是 i18n key（settings.themes.*，与 value 对齐）。 */
export const THEMES: readonly { value: ThemeId; label: string; description: string; colors: readonly [string, string, string] }[] = [
  { value: "greywork", label: "GreyWork", description: "settings.themes.greywork", colors: ["#000000", "#4d9fff", "#a1aacb"] },
  { value: "night-blue", label: "Night Blue", description: "settings.themes.nightBlue", colors: ["#050a12", "#4d9fff", "#8fb3d9"] },
  { value: "night-green", label: "Night Green", description: "settings.themes.nightGreen", colors: ["#040d07", "#2fbf71", "#7db894"] },
  { value: "github", label: "GitHub", description: "settings.themes.github", colors: ["#0d1117", "#2f81f7", "#8b949e"] },
  { value: "fox", label: "Fox", description: "settings.themes.fox", colors: ["#1a1210", "#fb923c", "#f1d5c5"] },
];

/** label 是 i18n key（settings.fontSizes.*，与 value 对齐）。 */
export const FONT_SIZES: readonly { value: FontSize; label: string; scale: number }[] = [
  { value: "small", label: "settings.fontSizes.small", scale: 0.9 },
  { value: "medium", label: "settings.fontSizes.medium", scale: 1 },
  { value: "large", label: "settings.fontSizes.large", scale: 1.15 },
];

const THEME_VALUES: Record<ThemeId, true> = { greywork: true, "night-blue": true, "night-green": true, github: true, fox: true };
const COLOR_MODE_VALUES: Record<ColorMode, true> = { dark: true, light: true, system: true };
const FONT_SIZE_VALUES: Record<FontSize, true> = { small: true, medium: true, large: true };

export const RUN_MODES: { value: RunMode; label: string; hint: string }[] = [
  { value: "local", label: "Local", hint: "settings.runModes.local.hint" },
  { value: "worktree", label: "Worktree", hint: "settings.runModes.worktree.hint" },
  { value: "cloud", label: "Cloud", hint: "settings.runModes.cloud.hint" },
];

/**
 * 用户声明的一台 MCP 服务器。
 *
 * 只有 `enabled` 的会随 `session/new` 下发给 agent——由 **agent** 去连接，
 * 工具并入它自己的工具面；宿主不代理工具调用（只在设置页「测试连接」时自己探一次活）。
 */
export interface McpServerEntry extends McpServerConfig {
  id: string;
  enabled: boolean;
}

const MCP_TRANSPORTS: Record<McpServerEntry["transport"], true> = { http: true, sse: true, stdio: true };

/**
 * 内置示例：DeepWiki 官方远程 MCP（streamable HTTP，无需鉴权）。
 *
 * 默认**不启用**：往每个 agent 会话里塞一个远程端点应当是用户的明确选择，
 * 而不是装好就默认外联。
 */
export const DEFAULT_MCP_SERVERS: readonly McpServerEntry[] = [
  { id: "deepwiki", name: "deepwiki", transport: "http", url: "https://mcp.deepwiki.com/mcp", enabled: false },
];

/** 单条通道的行为开关（每个通道独立一份：自动连接 / 自动回复 / 是否放行其他联系人）。 */
export interface ChannelPrefs {
  /** 应用启动时自动连上收消息。 */
  autoConnect: boolean;
  /** 收到消息自动调用本机助手回复；关掉则只记录不回复。 */
  autoReply: boolean;
  /** 是否也答复「本人以外」的联系人（默认只认归属人）。 */
  allowOtherSenders: boolean;
}

export const DEFAULT_CHANNEL_PREFS: ChannelPrefs = { autoConnect: true, autoReply: true, allowOtherSenders: false };

/**
 * 远程助手 · 通道与回复偏好。
 *
 * 回复后端是三个通道**共用**的一份设置（谁回答远程消息只有一个答案）；
 * 凭证不在这里 —— 微信的 bot token 在宿主数据目录，钉钉的 AppSecret / sessionWebhook
 * 同样只落宿主（设置快照会整份进 SQLite 与 localStorage，不适合放密钥）。
 */
/** 回复管线：本机模型供应商 / ACP 后端。 */
export type RemoteReplyMode = "llm" | "acp";

export interface RemoteAssistPrefs {
  /** 自动回复走哪条管线：本机模型供应商（llm）或 ACP 后端（acp）。 */
  replyMode: RemoteReplyMode;
  /**
   * ACP 模式下指定用哪个后端（agentProviders 里的 id）；null = 跟随对话页选中的后端。
   * 与对话页共用同一个 ACP 会话：选定后对话页的后端选择也会跟着切。
   */
  replyProviderId: string | null;
  channels: {
    wechat: ChannelPrefs;
    dingtalk: ChannelPrefs;
    feishu: ChannelPrefs;
  };
}

export const DEFAULT_REMOTE_ASSIST: RemoteAssistPrefs = {
  replyMode: "llm",
  replyProviderId: null,
  channels: {
    wechat: { ...DEFAULT_CHANNEL_PREFS },
    dingtalk: { ...DEFAULT_CHANNEL_PREFS },
    feishu: { ...DEFAULT_CHANNEL_PREFS },
  },
};

/** 通道标识（宿主侧命令前缀 / 事件名前缀同名）。 */
export type ChannelId = "wechat" | "dingtalk" | "feishu";

/** 持久化设置外形（字段均可缺省；缺失项回落默认值）。 */
export interface SavedSettings {
  /** 主题配色；旧快照可能是 dark/light/system，applySaved 会迁移到 colorMode。 */
  theme?: ThemeId | ColorMode;
  colorMode?: ColorMode;
  fontSize?: FontSize;
  locale?: AppLocale;
  selectedModelProviderId?: string | null;
  modelProviders?: ModelProviderConfig[];
  permissionTier?: PermTier;
  sandboxMode?: SandboxMode;
  workspaceDir?: string;
  mcpServers?: McpServerEntry[];
  /** 多智能体编排并发度（同时跑的回合上限）；1-8，越界静默回落 2。 */
  maxParallel?: number;
  /** 远程助手 · 通道与回复偏好（旧快照缺失 = 默认值）。 */
  remoteAssist?: Partial<RemoteAssistPrefs> & {
    channels?: { wechat?: Partial<ChannelPrefs>; dingtalk?: Partial<ChannelPrefs>; feishu?: Partial<ChannelPrefs> };
  };
  /** 远程助手 · 遗留字段（v1 快照只存过微信通道开关）：读入时迁移进 remoteAssist。 */
  wechatChannel?: Partial<ChannelPrefs> & { replyMode?: RemoteReplyMode; replyProviderId?: string | null };
}

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
  /**
   * 会话内临时降级到只读：**刻意不持久化**。
   *
   * 语义是「Full 会话内一键降 ReadOnly 跑完再升」——重启后应回到用户的基线档位，
   * 把它写进快照会让临时动作变成长期状态，正是这一项要避免的事。
   */
  const tempReadOnly = ref(false);
  /** 实际下发给宿主的档位：临时降级期间一律只读，否则用基线档位。 */
  const effectivePermissionTier = computed<PermTier>(() => (tempReadOnly.value ? "read-only" : permissionTier.value));
  /** 运行模式（顶栏胶囊）；worktree/cloud 为宿主能力预留，当前仅 local 生效。 */
  const runMode = ref<RunMode>("local");
  /** ACP 会话工作区目录（空 = 宿主私有 ~/.greyWork；宿主只接受已授权目录）。 */
  const workspaceDir = ref("");
  const planMode = ref(false);
  /** 主题配色与明暗模式正交：同一主题都提供浅色和深色。 */
  const theme = ref<ThemeId>("greywork");
  const colorMode = ref<ColorMode>("dark");
  /** 界面字号以整体 UI 缩放实现，固定像素字号与控件命中区一起保持比例。 */
  const fontSize = ref<FontSize>("medium");
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
  /** 远程助手 · 微信通道开关（登录凭证在宿主，不在快照里）。 */
  const remoteAssist = ref<RemoteAssistPrefs>({
    replyMode: DEFAULT_REMOTE_ASSIST.replyMode,
    replyProviderId: DEFAULT_REMOTE_ASSIST.replyProviderId,
    channels: {
      wechat: { ...DEFAULT_CHANNEL_PREFS },
      dingtalk: { ...DEFAULT_CHANNEL_PREFS },
      feishu: { ...DEFAULT_CHANNEL_PREFS },
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
    applyAppearanceToDom({ palette: theme.value, colorMode: colorMode.value, fontSize: fontSize.value });
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

  function applySaved(saved: SavedSettings | null | undefined): void {
    if (!saved) return;
    if (saved.permissionTier && PERM_TIER_VALUES[saved.permissionTier]) permissionTier.value = saved.permissionTier;
    // 无字段（旧快照）与非法值都迁移到 auto；绝不因损坏配置回落为直启。
    sandboxMode.value = saved.sandboxMode && SANDBOX_MODE_VALUES[saved.sandboxMode] ? saved.sandboxMode : "auto";
    if (typeof saved.workspaceDir === "string") workspaceDir.value = saved.workspaceDir;
    // 并发度：仅整数且落在区间内才接受；越界 / 非法值静默回落默认 2（不写通知）。
    if (Number.isInteger(saved.maxParallel)) {
      const n = saved.maxParallel as number;
      maxParallel.value = n >= MAX_PARALLEL_RANGE.min && n <= MAX_PARALLEL_RANGE.max ? n : 2;
    }
    if (saved.theme && THEME_VALUES[saved.theme as ThemeId]) theme.value = saved.theme as ThemeId;
    if (saved.colorMode && COLOR_MODE_VALUES[saved.colorMode]) colorMode.value = saved.colorMode;
    // v0.1 兼容：旧 theme 字段承载明暗模式；读入后下一次 persist 会写成新结构。
    else if (saved.theme && COLOR_MODE_VALUES[saved.theme as ColorMode]) colorMode.value = saved.theme as ColorMode;
    if (saved.fontSize && FONT_SIZE_VALUES[saved.fontSize]) fontSize.value = saved.fontSize;
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
        }));
      }
    }
    if (Array.isArray(saved.mcpServers)) {
      mcpServers.value = saved.mcpServers
        .filter((server) => server && typeof server.id === "string" && typeof server.name === "string" && MCP_TRANSPORTS[server.transport])
        .map((server) => ({ ...server, enabled: server.enabled === true }));
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
        channels: {
          wechat: normalizeChannel(remote?.channels?.wechat ?? legacy),
          dingtalk: normalizeChannel(remote?.channels?.dingtalk),
          feishu: normalizeChannel(remote?.channels?.feishu),
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
      locale: locale.value,
      selectedModelProviderId: selectedModelProviderId.value,
      modelProviders: modelProviders.value,
      permissionTier: permissionTier.value,
      sandboxMode: sandboxMode.value,
      workspaceDir: workspaceDir.value,
      mcpServers: mcpServers.value,
      maxParallel: maxParallel.value,
      remoteAssist: {
        replyMode: remoteAssist.value.replyMode,
        replyProviderId: remoteAssist.value.replyProviderId,
        channels: {
          wechat: { ...remoteAssist.value.channels.wechat },
          dingtalk: { ...remoteAssist.value.channels.dingtalk },
          feishu: { ...remoteAssist.value.channels.feishu },
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

  /* ===== 模型供应商管理（设置页编辑面） ===== */
  /** 选中即持久化（此前点选直接写 ref，重启即丢）。 */
  function selectModelProvider(id: string | null): void {
    selectedModelProviderId.value = id;
    persist();
  }

  /** 新增或整体覆盖一台模型供应商；写入前归一化 reasoningEffort。 */
  function upsertModelProvider(provider: ModelProviderConfig): void {
    const normalized = { ...provider, reasoningEffort: normalizeReasoningEffort(provider.reasoningEffort) };
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

  /** 更新某条通道的行为开关（部分字段）；落盘一次。 */
  function setChannelPrefs(channel: ChannelId, patch: Partial<ChannelPrefs>): void {
    remoteAssist.value = {
      ...remoteAssist.value,
      channels: { ...remoteAssist.value.channels, [channel]: { ...remoteAssist.value.channels[channel], ...patch } },
    };
    persist();
  }

  /** 更新共用回复设置（后端档位与选定的 ACP 后端）。 */
  function setRemoteAssist(patch: Partial<Pick<RemoteAssistPrefs, "replyMode" | "replyProviderId">>): void {
    remoteAssist.value = { ...remoteAssist.value, ...patch };
    persist();
  }

  return {
    permissionTier,
    sandboxMode,
    maxParallel,
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
    locale,
    selectedModelProviderId,
    modelProviders,
    mcpServers,
    enabledMcpServers,
    upsertMcpServer,
    removeMcpServer,
    setMcpServerEnabled,
    setAllMcpServersEnabled,
    remoteAssist,
    setChannelPrefs,
    setRemoteAssist,
    selectModelProvider,
    upsertModelProvider,
    removeModelProvider,
    resetModelProviders,
    persist,
    /** 桌面态启动接管完成信号（null = 浏览器态无后端）；await 后库内容已就位。 */
    hydrated: backendHydratePromise,
  };
});
