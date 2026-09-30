import { createJsonStorage } from "@greywork/core";
import type { McpServerConfig } from "@greywork/acp";
import {
  DEFAULT_MODEL_PROVIDERS,
  DEFAULT_OFFICE_PROVIDERS,
  SERVICE_FAMILIES,
  SERVICE_KINDS,
  type ModelProviderConfig,
  type OfficeProviderConfig,
  type ReasoningEffort,
  type ServiceProviderConfig,
} from "@greywork/shell";
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

/** 自定义请求头归一化：只留 string→string 非空项；形状不合法按「无附加头」处理（脏数据不拦启动）。 */
function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string" && headerValue !== "" && key.trim() !== "") headers[key] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** 采样温度归一：仅接受 [0, 2] 的有限数；其余按「不传」处理。 */
function normalizeTemperature(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2 ? value : undefined;
}

/** 最大输出 token 归一：仅接受正整数；其余按「不传」处理。 */
function normalizeMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 服务族清单的合法值（从共享表取，避免两处各写一份）。
 * 直接查 `SERVICE_FAMILIES` 而不是复制字面量：将来加族时这里自动跟上。
 */
function isServiceFamily(value: unknown): value is ServiceProviderConfig["family"] {
  return typeof value === "string" && (SERVICE_FAMILIES as readonly string[]).includes(value);
}

/**
 * kind 必须属于该族的清单。
 *
 * 只查「非空字符串」会放行 `kind: "wpss365"` 这种拼错的值：设置页下拉选不出它、宿主也不认，
 * 表现是「列表里有这条、预览却永远不走云端」，所以按 `SERVICE_KINDS` 逐族校验。
 */
function isServiceKind(family: ServiceProviderConfig["family"], value: unknown): value is string {
  return typeof value === "string" && SERVICE_KINDS[family].includes(value);
}

/**
 * 归一化一条服务配置：形状不对就丢弃（返回 null），而不是让脏数据进快照。
 *
 * 与 `normalizeChannel` 同思路 —— 旧快照/手改 JSON 都可能带缺字段的条目，
 * 拼装完整的默认值比在每个消费点各防一次省事得多。
 *
 * `recipe` 只做「字段类型对不对」的形状校验，**不校验语义**：配方是否真能用得跑一次才知道，
 * 而宿主侧（`office::validate_recipe`）已经会在调用时给出明确报错。这里拦的是
 * 「设置页表单写错类型」这种在渲染端就能发现的问题。
 */
function normalizeServiceProvider(raw: unknown): ServiceProviderConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim() === "") return null;
  if (!isServiceFamily(record.family)) return null;
  if (!isServiceKind(record.family, record.kind)) return null;

  const base = {
    id: record.id,
    // 名称缺失时回落 id：设置页上至少还能认出是哪一条，而不是一片空白。
    name: typeof record.name === "string" && record.name !== "" ? record.name : record.id,
    family: record.family,
    kind: record.kind,
    enabled: record.enabled === true,
    ...(typeof record.baseUrl === "string" && record.baseUrl !== "" ? { baseUrl: record.baseUrl } : {}),
    ...(typeof record.credentialEnv === "string" && record.credentialEnv !== "" ? { credentialEnv: record.credentialEnv } : {}),
    ...(normalizeHeaders(record.headers) ? { headers: normalizeHeaders(record.headers) } : {}),
    ...(typeof record.frameOrigin === "string" && record.frameOrigin !== "" ? { frameOrigin: record.frameOrigin } : {}),
  };

  if (record.family === "office") {
    const office = base as OfficeProviderConfig;
    if (typeof record.docsUrl === "string" && record.docsUrl !== "") office.docsUrl = record.docsUrl;
    const recipe = normalizeOfficeRecipe(record.recipe);
    if (recipe) office.recipe = recipe;
    return office;
  }
  // 其余三族本期只有信封字段，原样返回（各自的专属字段在后面加族时补齐）。
  return base as ServiceProviderConfig;
}

/** 归一化上传配方；形状不全一律返回 null（= 该服务商不可用，预览决策会跳过它）。 */
function normalizeOfficeRecipe(raw: unknown): OfficeProviderConfig["recipe"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.method !== "POST" && record.method !== "PUT") return undefined;
  if (typeof record.url !== "string" || record.url.trim() === "") return undefined;
  if (record.body !== "raw-bytes" && record.body !== "multipart") return undefined;
  if (typeof record.viewUrlPointer !== "string" || record.viewUrlPointer.trim() === "") return undefined;
  const recipe: NonNullable<OfficeProviderConfig["recipe"]> = {
    method: record.method,
    url: record.url,
    body: record.body,
    viewUrlPointer: record.viewUrlPointer,
  };
  if (typeof record.fileField === "string" && record.fileField !== "") recipe.fileField = record.fileField;
  if (typeof record.contentType === "string" && record.contentType !== "") recipe.contentType = record.contentType;
  if (typeof record.credentialHeader === "string" && record.credentialHeader !== "") {
    recipe.credentialHeader = record.credentialHeader;
  }
  return recipe;
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

const THEME_VALUES: Record<ThemeId, true> = {
  greywork: true,
  "night-blue": true,
  "night-green": true,
  github: true,
  fox: true,
  "liquid-glass": true,
};
const COLOR_MODE_VALUES: Record<ColorMode, true> = { dark: true, light: true, system: true };
const FONT_SIZE_VALUES: Record<FontSize, true> = { small: true, medium: true, large: true };
const RADIUS_VALUES: Record<Radius, true> = { none: true, small: true, large: true };
const RUN_MODE_VALUES: Record<RunMode, true> = { local: true, worktree: true, cloud: true };

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

const SKILL_SOURCE_TYPES: Record<SkillSourceEntry["type"], true> = { api: true, github: true };

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

/** 本地 AI 配置的读入归一：缺字段落默认、非法值丢弃（一条坏配置不该让整份设置失效）。 */
function normalizeLocalAi(raw: unknown): LocalAiPrefs {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as {
    rag?: Record<string, unknown>;
    stt?: Record<string, unknown>;
  };
  const rag = source.rag ?? {};
  const stt = source.stt ?? {};
  const rawTopK = typeof rag.topK === "number" && Number.isInteger(rag.topK) ? rag.topK : DEFAULT_LOCAL_AI.rag.topK;
  const topK = Math.min(Math.max(rawTopK, LOCAL_AI_TOP_K_RANGE.min), LOCAL_AI_TOP_K_RANGE.max);
  return {
    rag: {
      enabled: rag.enabled === true,
      providerId: typeof rag.providerId === "string" ? rag.providerId : null,
      embeddingModel: typeof rag.embeddingModel === "string" ? rag.embeddingModel : DEFAULT_LOCAL_AI.rag.embeddingModel,
      topK,
    },
    stt: {
      enabled: stt.enabled === true,
      providerId: typeof stt.providerId === "string" ? stt.providerId : null,
      model: typeof stt.model === "string" ? stt.model : DEFAULT_LOCAL_AI.stt.model,
    },
  };
}

/** 细粒度 ACP 配置覆盖的读入归一：只接受 `string -> string` 的键值对。 */
function normalizeAcpConfigValues(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key === "string" && typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

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
