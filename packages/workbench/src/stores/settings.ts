import { DEFAULT_AI_LOOP_POLICY, DEFAULT_MODEL_PROVIDERS, DEFAULT_WEB_SEARCH_PROVIDERS, type ModelProviderConfig } from "@greywork/shell";
import { defineStore } from "pinia";
import { ref } from "vue";

export type PermTier = "cautious" | "daily" | "auto";

/** 权限档位（盾牌三档 · 由原 PERMISSION_TIERS 重标签；宿主语义不变）。 */
export const PERMISSION_TIERS = [
  { value: "cautious", label: "只读", desc: "仅查看，任何写入与执行都需逐条确认" },
  { value: "daily", label: "允许编辑", desc: "自动执行，删文件 / 改系统目录时询问" },
  { value: "auto", label: "完全执行", desc: "不逐条征求许可" },
] as const;

export const PERM_LABELS: Record<PermTier, string> = { cautious: "只读", daily: "允许编辑", auto: "完全执行" };

export type RunMode = "local" | "worktree" | "cloud";
export type ThemeMode = "dark" | "light" | "system";
export const RUN_MODES: { value: RunMode; label: string; hint: string }[] = [
  { value: "local", label: "Local", hint: "当前工作区直接执行" },
  { value: "worktree", label: "Worktree", hint: "宿主能力预留：独立 worktree 执行（未接入）" },
  { value: "cloud", label: "Cloud", hint: "宿主能力预留：云端执行（未接入）" },
];

/** 全局设置：权限档位 / 计划模式 / token 快照 / 供应商芯片 / 已启用插件。 */
export const useSettingsStore = defineStore("settings", () => {
  const permissionTier = ref<PermTier>("daily");
  /** 运行模式（顶栏胶囊）；worktree/cloud 为宿主能力预留，当前仅 local 生效。 */
  const runMode = ref<RunMode>("local");
  /** ACP 会话工作区目录（空 = 桌面主目录；宿主侧校验绝对路径且非根）。 */
  const workspaceDir = ref("");
  const planMode = ref(false);
  const theme = ref<ThemeMode>("light");
  const selectedModelProviderId = ref<string | null>(null);
  /** tokens.css 派生只读快照（AppShell bootstrap 时填充；不提供写接口）。 */
  const modelProviders = ref<ModelProviderConfig[]>(
    DEFAULT_MODEL_PROVIDERS.map((provider) => ({
      ...provider,
      reasoningEffort: provider.reasoningEffort ?? "medium",
    })),
  );
  const webSearchProviders = DEFAULT_WEB_SEARCH_PROVIDERS;
  /** 注册表激活项（plugins/loader 驱动）。 */
  const enabledPlugins = ref(new Set<string>());

  function loadPersisted(): void {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("greywork.settings");
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        theme?: ThemeMode;
        selectedModelProviderId?: string | null;
        modelProviders?: ModelProviderConfig[];
      };
      if (saved.theme === "dark" || saved.theme === "light" || saved.theme === "system") theme.value = saved.theme;
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
        if (valid.length) modelProviders.value = valid;
      }
    } catch {
      // 损坏的本地设置不应阻塞工作台启动，继续使用默认值。
    }
  }

  function persist(): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "greywork.settings",
      JSON.stringify({ theme: theme.value, selectedModelProviderId: selectedModelProviderId.value, modelProviders: modelProviders.value }),
    );
  }

  loadPersisted();

  function syncEnabledPlugins(ids: readonly string[]): void {
    enabledPlugins.value = new Set(ids);
  }

  return {
    permissionTier,
    runMode,
    workspaceDir,
    planMode,
    theme,
    selectedModelProviderId,
    modelProviders,
    webSearchProviders,
    enabledPlugins,
    syncEnabledPlugins,
    persist,
    aiLoopPolicy: DEFAULT_AI_LOOP_POLICY,
  };
});
