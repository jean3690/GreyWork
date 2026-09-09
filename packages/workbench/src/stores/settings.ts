import { createJsonStorage } from "@greywork/core";
import type { McpServerConfig } from "@greywork/acp";
import { DEFAULT_MODEL_PROVIDERS, DEFAULT_WEB_SEARCH_PROVIDERS, type ModelProviderConfig, type ReasoningEffort } from "@greywork/shell";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { settingsBackend } from "../lib/settings-backend";
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

/** 沙盒档位（方案 2 P1：宿主 OS 级隔离）。label/desc 为 i18n key。 */
export type SandboxMode = "off" | "fs" | "full";
export const SANDBOX_MODES: { value: SandboxMode; label: string; desc: string }[] = [
  { value: "off", label: "settings.sandbox.off.label", desc: "settings.sandbox.off.desc" },
  { value: "fs", label: "settings.sandbox.fs.label", desc: "settings.sandbox.fs.desc" },
  { value: "full", label: "settings.sandbox.full.label", desc: "settings.sandbox.full.desc" },
];

const SANDBOX_MODE_VALUES: Record<SandboxMode, true> = { off: true, fs: true, full: true };

/** 编排并发度合法区间（含端点）。 */
export const MAX_PARALLEL_RANGE = { min: 1, max: 8 } as const;

/**
 * 权限档位 → 建议沙盒档位。
 *
 * 两者是**互相独立**的边界：权限三档是宿主在 ACP 工具调用层的授权判定
 * （acp_host.rs 的 PermissionTier），沙盒档位是 bwrap 在 OS 层的隔离
 * （sandbox.rs）。授权放得越宽，越需要 OS 层兜底 —— `full` 权限 + `off` 沙盒
 * 等于没有任何边界，因此这里给出配套建议供设置页一键联动。
 */
export function recommendedSandboxMode(tier: PermTier): SandboxMode {
  switch (tier) {
    // 只读档没有写入面，OS 隔离收益低，反而挡掉 agent 读配置
    case "read-only":
      return "off";
    case "workspace":
      return "fs";
    case "full":
      return "full";
  }
}

export type RunMode = "local" | "worktree" | "cloud";
export type ThemeMode = "dark" | "light" | "system";
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

/** 持久化设置外形（字段均可缺省；缺失项回落默认值）。 */
export interface SavedSettings {
  theme?: ThemeMode;
  locale?: AppLocale;
  selectedModelProviderId?: string | null;
  modelProviders?: ModelProviderConfig[];
  permissionTier?: PermTier;
  sandboxMode?: SandboxMode;
  workspaceDir?: string;
  mcpServers?: McpServerEntry[];
  /** 多智能体编排并发度（同时跑的回合上限）；1-8，越界静默回落 2。 */
  maxParallel?: number;
}

const settingsStorage = createJsonStorage<SavedSettings>(
  "greywork.settings",
  (value): value is SavedSettings => typeof value === "object" && value !== null && !Array.isArray(value),
);

/** 全局设置：权限档位 / 计划模式 / token 快照 / 供应商芯片 / MCP 服务器声明。 */
export const useSettingsStore = defineStore("settings", () => {
  const permissionTier = ref<PermTier>("workspace");
  /** 沙盒档位：off 直启；fs = bwrap 文件系统隔离 + 网络关闭；full = 隔离 + 网络放行。 */
  const sandboxMode = ref<SandboxMode>("off");
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
  /** ACP 会话工作区目录（空 = 桌面主目录；宿主侧校验绝对路径且非根）。 */
  const workspaceDir = ref("");
  const planMode = ref(false);
  /* 默认暗色优先（GreyWork 旗舰外观）；浅色在设置里手动可选，system 跟随系统。 */
  const theme = ref<ThemeMode>("dark");
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
  const webSearchProviders = DEFAULT_WEB_SEARCH_PROVIDERS;
  /** 已声明的 MCP 服务器（含未启用项）。 */
  const mcpServers = ref<McpServerEntry[]>(DEFAULT_MCP_SERVERS.map((server) => ({ ...server })));
  /** 下发给 agent 的那一批：只取启用项，并剥掉 id/enabled 这类纯本地字段。 */
  const enabledMcpServers = computed<McpServerConfig[]>(() =>
    mcpServers.value.filter((server) => server.enabled).map(({ id: _id, enabled: _enabled, ...config }) => config),
  );

  /** 校验并应用一份持久化快照（localStorage / SQLite 共用同一校验面）。 */
  const PERM_TIER_VALUES: Record<PermTier, true> = { "read-only": true, workspace: true, full: true };

  function applySaved(saved: SavedSettings | null | undefined): void {
    if (!saved) return;
    if (saved.permissionTier && PERM_TIER_VALUES[saved.permissionTier]) permissionTier.value = saved.permissionTier;
    if (saved.sandboxMode && SANDBOX_MODE_VALUES[saved.sandboxMode]) sandboxMode.value = saved.sandboxMode;
    if (typeof saved.workspaceDir === "string") workspaceDir.value = saved.workspaceDir;
    // 并发度：仅整数且落在区间内才接受；越界 / 非法值静默回落默认 2（不写通知）。
    if (Number.isInteger(saved.maxParallel)) {
      const n = saved.maxParallel as number;
      maxParallel.value = n >= MAX_PARALLEL_RANGE.min && n <= MAX_PARALLEL_RANGE.max ? n : 2;
    }
    if (saved.theme === "dark" || saved.theme === "light" || saved.theme === "system") theme.value = saved.theme;
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
  }

  function persist(): void {
    const snapshot: SavedSettings = {
      theme: theme.value,
      locale: locale.value,
      selectedModelProviderId: selectedModelProviderId.value,
      modelProviders: modelProviders.value,
      permissionTier: permissionTier.value,
      sandboxMode: sandboxMode.value,
      workspaceDir: workspaceDir.value,
      mcpServers: mcpServers.value,
      maxParallel: maxParallel.value,
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
    locale,
    selectedModelProviderId,
    modelProviders,
    webSearchProviders,
    mcpServers,
    enabledMcpServers,
    upsertMcpServer,
    removeMcpServer,
    setMcpServerEnabled,
    selectModelProvider,
    upsertModelProvider,
    removeModelProvider,
    resetModelProviders,
    persist,
    /** 桌面态启动接管完成信号（null = 浏览器态无后端）；await 后库内容已就位。 */
    hydrated: backendHydratePromise,
  };
});
