/**
 * 设置的**类型与默认值**：枚举、常量清单、持久化外形。
 *
 * 从 `settings.ts` 拆出（P5 大文件拆分）：这里只有纯声明（类型 + 字面量），
 * 无副作用、无 store 依赖，设置页与归一化层都从这里取。
 */
import type { McpServerConfig } from "@greywork/acp";
import type { ModelProviderConfig, ServiceProviderConfig } from "@greywork/shell";
import type { AppLocale } from "../../i18n";

export type PermTier = "read-only" | "workspace" | "full";

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

/** 编排并发度合法区间（含端点）。 */
export const MAX_PARALLEL_RANGE = { min: 1, max: 8 } as const;

/** 权限档位 → 建议沙盒策略。默认一律 auto；放行网络必须由用户显式选择 full。 */
export function recommendedSandboxMode(_tier: PermTier): SandboxMode {
  return "auto";
}

export type RunMode = "local" | "worktree" | "cloud";
export type ThemeId = "greywork" | "night-blue" | "night-green" | "github" | "fox" | "liquid-glass";
export type ColorMode = "dark" | "light" | "system";
export type FontSize = "small" | "medium" | "large";
/** 界面圆角档位：none / small（= 改造前的原值）/ large。 */
export type Radius = "none" | "small" | "large";

/** label 是专有名词（不翻译），description 是 i18n key（settings.themes.*，与 value 对齐）。 */
export const THEMES: readonly { value: ThemeId; label: string; description: string; colors: readonly [string, string, string] }[] = [
  { value: "greywork", label: "GreyWork", description: "settings.themes.greywork", colors: ["#000000", "#4d9fff", "#a1aacb"] },
  { value: "night-blue", label: "Night Blue", description: "settings.themes.nightBlue", colors: ["#050a12", "#4d9fff", "#8fb3d9"] },
  { value: "night-green", label: "Night Green", description: "settings.themes.nightGreen", colors: ["#040d07", "#2fbf71", "#7db894"] },
  { value: "github", label: "GitHub", description: "settings.themes.github", colors: ["#0d1117", "#2f81f7", "#8b949e"] },
  { value: "fox", label: "Fox", description: "settings.themes.fox", colors: ["#1a1210", "#fb923c", "#f1d5c5"] },
  { value: "liquid-glass", label: "Liquid Glass", description: "settings.themes.liquidGlass", colors: ["#26324d", "#5aa8ff", "#cdd6ea"] },
];

/** label 是 i18n key（settings.fontSizes.*，与 value 对齐）。 */
export const FONT_SIZES: readonly { value: FontSize; label: string; scale: number }[] = [
  { value: "small", label: "settings.fontSizes.small", scale: 0.9 },
  { value: "medium", label: "settings.fontSizes.medium", scale: 1 },
  { value: "large", label: "settings.fontSizes.large", scale: 1.15 },
];

/**
 * label 是 i18n key（settings.radii.*，与 value 对齐）。
 *
 * scale 乘在每一个装饰性圆角上（见 theme/base.css 的 `--gw-radius-scale`）；`small`
 * 就是改造前的原值，所以它等价于「没有这个设置」。
 */
export const RADII: readonly { value: Radius; label: string; scale: number }[] = [
  { value: "none", label: "settings.radii.none", scale: 0 },
  { value: "small", label: "settings.radii.small", scale: 1 },
  { value: "large", label: "settings.radii.large", scale: 1.5 },
];

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

/**
 * 用户自定义的技能市场源。
 *
 * 每个源指向一个兼容 skills.sh API 的端点（搜索 / 下载），
 * 或者是一个 GitHub 仓库 owner/repo 格式的直接引用。
 */
export interface SkillSourceEntry {
  id: string;
  /** 显示名称。 */
  label: string;
  /** 源类型：api = 兼容 skills.sh 的 HTTP API；github = GitHub 仓库直引。 */
  type: "api" | "github";
  /** API 端点 URL（type=api 时必填）。 */
  url?: string;
  /** GitHub owner/repo（type=github 时必填）。 */
  repo?: string;
  enabled: boolean;
}

/** 内置默认技能源（skills.sh 聚合索引）。 */
export const DEFAULT_SKILL_SOURCES: readonly SkillSourceEntry[] = [
  { id: "skills-sh", label: "Skills Directory", type: "api", url: "https://www.skills.sh", enabled: true },
];

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

/** 回复管线：本机模型供应商 / ACP 后端。 */
export type RemoteReplyMode = "llm" | "acp";

/**
 * 远程助手 · 通道与回复偏好。
 *
 * 回复后端是三个通道**共用**的一份设置（谁回答远程消息只有一个答案）；
 * 凭证不在这里 —— 微信的 bot token 在宿主数据目录，钉钉的 AppSecret / sessionWebhook
 * 同样只落宿主（设置快照会整份进 SQLite 与 localStorage，不适合放密钥）。
 */
export interface RemoteAssistPrefs {
  /** 自动回复走哪条管线：本机模型供应商（llm）或 ACP 后端（acp）。 */
  replyMode: RemoteReplyMode;
  /**
   * ACP 模式下指定用哪个后端（agentProviders 里的 id）；null = 跟随对话页选中的后端。
   * 与对话页共用同一个 ACP 会话：选定后对话页的后端选择也会跟着切。
   */
  replyProviderId: string | null;
  /**
   * ACP 回合的细粒度配置覆盖：`{ [configOptionId]: value }`（如 model / effort / mode）。
   *
   * 只在选项真的存在于 `acpConfigOptions` 时才下发，且每次远程 ACP 回合前应用一次——
   * agent 换模型会重发整份 config options，这里存的是「这台机器的远程助手习惯」，
   * 与对话页按工作区记忆的选择互不覆盖（键不同：那份记在 workspace.agentConfig）。
   */
  acpConfigValues: Record<string, string>;
  channels: {
    wechat: ChannelPrefs;
    dingtalk: ChannelPrefs;
    feishu: ChannelPrefs;
    telegram: ChannelPrefs;
    qq: ChannelPrefs;
    discord: ChannelPrefs;
    wecom: ChannelPrefs;
  };
}

export const DEFAULT_REMOTE_ASSIST: RemoteAssistPrefs = {
  replyMode: "llm",
  replyProviderId: null,
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
};

/**
 * 本地 AI 配置：本地检索（RAG）与本地语音转写（STT）。
 *
 * 两者都**复用模型供应商**（baseUrl / 密钥环境变量取自 modelProviders），只额外记
 * 「用哪个供应商 + 用哪个模型」—— embedding / whisper 模型与对话模型不同，所以要单独给模型名。
 * 默认全关：没配置时行为与加这个功能之前完全一致（附件仍以路径引用递给模型）。
 */
export interface LocalAiPrefs {
  rag: {
    enabled: boolean;
    /** 取 embedding 的供应商 id（null = 用当前选中的对话供应商）。 */
    providerId: string | null;
    /** embedding 模型名（如 bge-m3 / nomic-embed-text）。 */
    embeddingModel: string;
    /** 每次检索注入的块数上限。 */
    topK: number;
  };
  stt: {
    enabled: boolean;
    /** 取语音转写的供应商 id（null = 用当前选中的对话供应商）。 */
    providerId: string | null;
    /** whisper 模型名（如 whisper-1）。 */
    model: string;
  };
}

export const DEFAULT_LOCAL_AI: LocalAiPrefs = {
  rag: { enabled: false, providerId: null, embeddingModel: "bge-m3", topK: 6 },
  stt: { enabled: false, providerId: null, model: "whisper-1" },
};

/** 检索注入块数的合法区间（与宿主 `rag_search` 的 clamp 对齐）。 */
export const LOCAL_AI_TOP_K_RANGE = { min: 1, max: 50 } as const;

/** 通道标识（宿主侧命令前缀 / 事件名前缀同名）。 */
export type ChannelId = "wechat" | "dingtalk" | "feishu" | "telegram" | "qq" | "discord" | "wecom";

/** 持久化设置外形（字段均可缺省；缺失项回落默认值）。 */
export interface SavedSettings {
  /** 主题配色；旧快照可能是 dark/light/system，applySaved 会迁移到 colorMode。 */
  theme?: ThemeId | ColorMode;
  colorMode?: ColorMode;
  fontSize?: FontSize;
  /** 界面圆角档位；缺失（旧快照）回落 small = 改造前的原值。 */
  radius?: Radius;
  locale?: AppLocale;
  selectedModelProviderId?: string | null;
  modelProviders?: ModelProviderConfig[];
  permissionTier?: PermTier;
  sandboxMode?: SandboxMode;
  workspaceDir?: string;
  /** 运行模式；未接入的档位（cloud）也照存，由 UI 负责标注它不生效。 */
  runMode?: RunMode;
  mcpServers?: McpServerEntry[];
  /** 用户自定义技能市场源。 */
  skillSources?: SkillSourceEntry[];
  /** 多智能体编排并发度（同时跑的回合上限）；1-8，越界静默回落 2。 */
  maxParallel?: number;
  /** 关闭窗口时是否只隐藏到系统托盘（默认 true）；宿主据此决定拦不拦 CloseRequested。 */
  closeToTray?: boolean;
  /** 远程助手 · 通道与回复偏好（旧快照缺失 = 默认值）。 */
  remoteAssist?: Partial<Omit<RemoteAssistPrefs, "channels">> & {
    channels?: {
      wechat?: Partial<ChannelPrefs>;
      dingtalk?: Partial<ChannelPrefs>;
      feishu?: Partial<ChannelPrefs>;
      telegram?: Partial<ChannelPrefs>;
      qq?: Partial<ChannelPrefs>;
      discord?: Partial<ChannelPrefs>;
      wecom?: Partial<ChannelPrefs>;
    };
  };
  /** 远程助手 · 遗留字段（v1 快照只存过微信通道开关）：读入时迁移进 remoteAssist。 */
  wechatChannel?: Partial<ChannelPrefs> & { replyMode?: RemoteReplyMode; replyProviderId?: string | null };
  /**
   * 第三方服务配置（office / model / storage / scheduler 四族共用一份清单）。
   * 只存「去哪个环境变量取凭证」，**从不存凭证明文**（见 @greywork/shell 的 services.ts）。
   */
  serviceProviders?: ServiceProviderConfig[];
  /** 云端 Office 预览选中的服务商 id；null = 用第一个可用的。 */
  selectedOfficeProviderId?: string | null;
  /** 本地 AI（RAG 检索 / STT 语音转写）配置。 */
  localAi?: { rag?: Partial<LocalAiPrefs["rag"]>; stt?: Partial<LocalAiPrefs["stt"]> };
}
