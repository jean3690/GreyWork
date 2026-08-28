import { createJsonStorage } from "@greywork/core";
import {
  DEFAULT_AI_LOOP_POLICY,
  DEFAULT_MODEL_PROVIDERS,
  DEFAULT_WEB_SEARCH_PROVIDERS,
  createDefaultCliIntegrations,
  type CliIntegration,
  type ModelProviderConfig,
  type ReasoningEffort,
} from "@greywork/shell";
import { defineStore } from "pinia";
import { ref } from "vue";
import type { AppLocale } from "../i18n";

export type PermTier = "cautious" | "daily" | "auto";

/** 推理等级合法值（shell REASONING_EFFORTS 的 value 集）。 */
const REASONING_EFFORT_VALUES: ReadonlySet<string> = new Set(["auto", "low", "medium", "high", "max"]);

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_VALUES.has(value) ? (value as ReasoningEffort) : "auto";
}

/** 权限档位（盾牌三档 · 由原 PERMISSION_TIERS 重标签；宿主语义不变）。label/desc 为 i18n key，渲染处 t() 转译。 */
export const PERMISSION_TIERS = [
  { value: "cautious", label: "settings.permissions.cautious.label", desc: "settings.permissions.cautious.desc" },
  { value: "daily", label: "settings.permissions.daily.label", desc: "settings.permissions.daily.desc" },
  { value: "auto", label: "settings.permissions.auto.label", desc: "settings.permissions.auto.desc" },
] as const;

export const PERM_LABELS: Record<PermTier, string> = {
  cautious: "settings.permissions.cautious.label",
  daily: "settings.permissions.daily.label",
  auto: "settings.permissions.auto.label",
};

export type RunMode = "local" | "worktree" | "cloud";
export type ThemeMode = "dark" | "light" | "system";
export const RUN_MODES: { value: RunMode; label: string; hint: string }[] = [
  { value: "local", label: "Local", hint: "settings.runModes.local.hint" },
  { value: "worktree", label: "Worktree", hint: "settings.runModes.worktree.hint" },
  { value: "cloud", label: "Cloud", hint: "settings.runModes.cloud.hint" },
];

/** 持久化设置外形（字段均可缺省；缺失项回落默认值）。 */
interface SavedSettings {
  theme?: ThemeMode;
  locale?: AppLocale;
  selectedModelProviderId?: string | null;
  modelProviders?: ModelProviderConfig[];
  cliIntegrations?: CliIntegration[];
}

const settingsStorage = createJsonStorage<SavedSettings>(
  "greywork.settings",
  (value): value is SavedSettings => typeof value === "object" && value !== null && !Array.isArray(value),
);

/** 全局设置：权限档位 / 计划模式 / token 快照 / 供应商芯片 / 已启用插件。 */
export const useSettingsStore = defineStore("settings", () => {
  const permissionTier = ref<PermTier>("daily");
  /** 运行模式（顶栏胶囊）；worktree/cloud 为宿主能力预留，当前仅 local 生效。 */
  const runMode = ref<RunMode>("local");
  /** ACP 会话工作区目录（空 = 桌面主目录；宿主侧校验绝对路径且非根）。 */
  const workspaceDir = ref("");
  const planMode = ref(false);
  const theme = ref<ThemeMode>("light");
  /** 界面语言（i18n 实例初值同源于此 localStorage；切换经 AppShell watch → setLocale）。 */
  const locale = ref<AppLocale>("zh-CN");
  const selectedModelProviderId = ref<string | null>(null);
  /** tokens.css 派生只读快照（AppShell bootstrap 时填充；不提供写接口）。 */
  const modelProviders = ref<ModelProviderConfig[]>(
    DEFAULT_MODEL_PROVIDERS.map((provider) => ({
      ...provider,
      reasoningEffort: provider.reasoningEffort ?? "auto",
    })),
  );
  const webSearchProviders = DEFAULT_WEB_SEARCH_PROVIDERS;
  /** CLI 接入清单（openai / claude / 自定义；reasoningEffort 与模型供应商统一枚举）。 */
  const cliIntegrations = ref<CliIntegration[]>(createDefaultCliIntegrations());
  /** 注册表激活项（plugins/loader 驱动）。 */
  const enabledPlugins = ref(new Set<string>());

  function loadPersisted(): void {
    const saved = settingsStorage.read();
    if (!saved) return;
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
    if (Array.isArray(saved.cliIntegrations)) {
      const validCli = saved.cliIntegrations.filter((cli) => cli && typeof cli.id === "string" && typeof cli.name === "string");
      if (validCli.length) {
        cliIntegrations.value = validCli.map((cli) => ({
          ...cli,
          reasoningEffort: normalizeReasoningEffort(cli.reasoningEffort),
        }));
      }
    }
  }

  function persist(): void {
    settingsStorage.write({
      theme: theme.value,
      locale: locale.value,
      selectedModelProviderId: selectedModelProviderId.value,
      modelProviders: modelProviders.value,
      cliIntegrations: cliIntegrations.value,
    });
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
    locale,
    selectedModelProviderId,
    modelProviders,
    cliIntegrations,
    webSearchProviders,
    enabledPlugins,
    syncEnabledPlugins,
    persist,
    aiLoopPolicy: DEFAULT_AI_LOOP_POLICY,
  };
});
