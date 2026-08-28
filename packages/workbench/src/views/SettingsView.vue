<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { REASONING_EFFORTS, createCliSessionManager, type ReasoningEffort } from "@greywork/shell";
import { Brain, Cpu, Plug, Settings2, Terminal } from "lucide-vue-next";
import { capabilitySeam } from "../plugins/loader";
import { Button, Badge, DataTable, Input, Select, Switch, type TableColumn } from "../components/ui";
import { useSettingsStore, type ThemeMode } from "../stores/settings";
import { getPluginMarket, persistRegisteredMcp, removeRegisteredMcp } from "../state/pluginMarket";
import { PROVIDER_TONES } from "../lib/tones";
import type { AppLocale } from "../i18n";

const { t } = useI18n();

/* ===== 一切皆插件：能力注册表（loader 双向联动，常驻可达） ===== */
const registryIds = ref<readonly string[]>(capabilitySeam.activeIds());

function refreshRegistry(): void {
  registryIds.value = capabilitySeam.activeIds();
  useSettingsStore().syncEnabledPlugins(capabilitySeam.activeIds());
}

async function toggleBuiltin(active: boolean): Promise<void> {
  try {
    if (active) await capabilitySeam.activate("core.builtin");
    else await capabilitySeam.deactivate("core.builtin");
  } finally {
    refreshRegistry();
  }
}

const builtinActive = computed(() => registryIds.value.includes("core.builtin"));

const settings = useSettingsStore();

const activeSettingsTab = ref<"providers" | "cli" | "reasoning" | "general" | "mcp">("providers");

const settingsTabs = [
  { value: "providers" as const, label: "settings.tabs.providers", icon: Cpu },
  { value: "cli" as const, label: "settings.tabs.cli", icon: Terminal },
  { value: "reasoning" as const, label: "settings.tabs.reasoning", icon: Brain },
  { value: "mcp" as const, label: "settings.tabs.mcp", icon: Plug },
  { value: "general" as const, label: "settings.tabs.general", icon: Settings2 },
];

const cliSessionManager = createCliSessionManager();
const cliSessions = ref(
  cliSessionManager.list().map((session) => ({
    ...session,
    statusLabel: session.status === "running" ? t("common.running") : t("common.finished"),
  })),
);
/** 推理等级单源：读写当前选中模型供应商的 reasoningEffort（settings 持久化）。 */
const activeProviderEffort = computed<ReasoningEffort>({
  get: () => {
    const provider = settings.modelProviders.find((provider) => provider.id === settings.selectedModelProviderId);
    return provider?.reasoningEffort ?? "auto";
  },
  set: (value) => {
    const provider = settings.modelProviders.find((provider) => provider.id === settings.selectedModelProviderId);
    if (provider) provider.reasoningEffort = value;
  },
});
const hasActiveProvider = computed(() => settings.modelProviders.some((provider) => provider.id === settings.selectedModelProviderId));
const settingsTheme = computed<ThemeMode>({
  get: () => settings.theme,
  set: (value) => {
    settings.theme = value;
  },
});
/** 语言选项（computed：locale 切换后 label 随翻译刷新）。 */
const languageOptions = computed<{ label: string; value: AppLocale }[]>(() => [
  { label: t("settings.language.zhCN"), value: "zh-CN" },
  { label: t("settings.language.enUS"), value: "en-US" },
]);
const saveState = ref<"idle" | "saved" | "error">("idle");

function applyTheme(theme: ThemeMode): void {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
}

watch(() => settings.theme, applyTheme, { immediate: true });

/* ===== MCP 服务器：已登记清单 → 开关控制启用（行列式） ===== */
const pluginMarket = getPluginMarket();
const mcpServers = computed(() => pluginMarket.marketplace.filter((manifest) => manifest.id.startsWith("mcp-")));

function isMcpInstalled(id: string): boolean {
  return pluginMarket.installedIds().includes(id);
}

function toggleMcp(id: string): void {
  if (isMcpInstalled(id)) {
    pluginMarket.uninstall(id);
    removeRegisteredMcp(id);
  } else {
    pluginMarket.install(id);
    const manifest = pluginMarket.marketplace.find((item) => item.id === id);
    if (manifest) persistRegisteredMcp(manifest);
  }
}

const providerKindOptions = [
  { label: "OpenAI Compatible", value: "openai-compatible" },
  { label: "Anthropic", value: "anthropic" },
  { label: "Ollama", value: "ollama" },
  { label: t("settings.providerKinds.custom"), value: "custom" },
];
const reasoningOptions = REASONING_EFFORTS.map((item) => ({ label: t(item.label), value: item.value }));
const themeOptions = [
  { label: t("settings.theme.dark"), value: "dark" },
  { label: t("settings.theme.light"), value: "light" },
  { label: t("settings.theme.system"), value: "system" },
];

const cliColumns: TableColumn[] = [
  { title: "CLI", key: "cliId", width: 120 },
  { title: t("settings.cliColumns.session"), key: "title" },
  { title: t("settings.cliColumns.status"), key: "status", width: 90 },
  { title: t("settings.cliColumns.actions"), key: "statusLabel", width: 90 },
];

function addModelProvider(): void {
  settings.modelProviders.push({
    id: "custom-" + Date.now(),
    name: t("settings.customProviderName"),
    kind: "custom",
    baseUrl: "https://api.example.com/v1",
    model: "your-model",
    apiKeyEnv: "CUSTOM_LLM_API_KEY",
    enabled: false,
    reasoningEffort: "auto",
  });
}

function removeModelProvider(id: string): void {
  settings.modelProviders = settings.modelProviders.filter((provider) => provider.id !== id);
}

function startCliSession(cliId: string): void {
  const cli = settings.cliIntegrations.find((item) => item.id === cliId);
  cliSessionManager.start(cliId, (cli?.name ?? cliId) + t("settings.newSession"));
  cliSessions.value = cliSessionManager.list().map((session) => ({
    ...session,
    statusLabel: session.status === "running" ? t("common.running") : t("common.finished"),
  }));
}

function saveSettings(): void {
  try {
    settings.persist();
    saveState.value = "saved";
  } catch (error) {
    console.error("settings save failed", error);
    saveState.value = "error";
  }
}
</script>

<template>
  <section class="view">
    <div class="view__head">
      <div>
        <p class="view__eyebrow">SETTINGS</p>
        <h1 class="view__title">{{ t("settings.title") }}</h1>
        <p class="view__sub">{{ t("settings.sub") }}</p>
      </div>
      <div class="view__actions">
        <span v-if="saveState === 'saved'" class="footnote">{{ t("common.saved") }}</span>
        <span v-else-if="saveState === 'error'" class="footnote text-destructive">{{ t("common.saveFailed") }}</span>
        <Button @click="saveSettings">{{ t("common.save") }}</Button>
      </div>
    </div>
    <div class="settings-shell">
      <nav class="settings-nav" :aria-label="t('settings.navLabel')">
        <button
          v-for="tab in settingsTabs"
          :key="tab.value"
          class="settings-nav__item"
          :class="{ active: activeSettingsTab === tab.value }"
          @click="activeSettingsTab = tab.value"
        >
          <component :is="tab.icon" class="size-4" />
          {{ t(tab.label) }}
        </button>
      </nav>
      <div class="settings-body">
        <div v-show="activeSettingsTab === 'providers'" class="pt-5">
          <div class="settings-grid">
            <div v-for="(p, i) in settings.modelProviders" :key="p.id" class="setting-card">
              <div class="setting-card__head">
                <span class="provider-logo" :style="{ background: PROVIDER_TONES[i % PROVIDER_TONES.length] }">{{
                  p.name.slice(0, 1)
                }}</span>
                <div class="setting-card__meta">
                  <strong>{{ p.name }}</strong>
                  <span>{{ p.model || t("settings.noModel") }}</span>
                </div>
                <Badge :type="p.enabled ? 'success' : 'default'" round>{{ p.enabled ? t("common.enabled") : t("common.disabled") }}</Badge>
                <Switch v-model="p.enabled" />
              </div>
              <div class="setting-fields">
                <Input v-model="p.name" :placeholder="t('settings.name')" class="h-8 text-xs" />
                <Select v-model="p.kind" :options="providerKindOptions" trigger-class="h-8" />
                <Input v-model="p.baseUrl" placeholder="Base URL" class="h-8 text-xs" />
                <Input v-model="p.model" :placeholder="t('settings.modelPlaceholder')" class="h-8 text-xs" />
                <Input v-model="p.apiKeyEnv" :placeholder="t('settings.apiKeyEnv')" class="h-8 text-xs" />
                <Select v-model="p.reasoningEffort" :options="reasoningOptions" trigger-class="h-8" />
              </div>
              <Button variant="ghost" size="sm" @click="removeModelProvider(p.id)">{{ t("common.delete") }}</Button>
            </div>
          </div>
          <Button size="sm" @click="addModelProvider">{{ t("settings.addProvider") }}</Button>
        </div>

        <div v-show="activeSettingsTab === 'cli'" class="pt-5">
          <div class="settings-grid">
            <div v-for="c in settings.cliIntegrations" :key="c.id" class="setting-card">
              <div class="setting-card__head">
                <Badge :type="c.available ? 'success' : 'warning'" round>{{ c.kind }}</Badge>
                <strong>{{ c.name }}</strong>
                <Button size="sm" @click="startCliSession(c.id)">{{ t("settings.startSession") }}</Button>
              </div>
              <div class="setting-fields">
                <Input v-model="c.command" :placeholder="t('settings.cliCommand')" class="h-8 text-xs" />
                <Select v-model="c.reasoningEffort" :options="reasoningOptions" trigger-class="h-8" />
              </div>
            </div>
          </div>
          <div class="settings-subhead">{{ t("settings.cliSessions") }}</div>
          <DataTable :columns="cliColumns" :data="cliSessions" class="text-xs" />
        </div>

        <div v-show="activeSettingsTab === 'reasoning'" class="pt-5">
          <p v-if="!hasActiveProvider" class="footnote mb-3">{{ t("settings.noProviderHint") }}</p>
          <div class="reasoning-list">
            <label v-for="e in REASONING_EFFORTS" :key="e.value" class="reasoning-item">
              <input v-model="activeProviderEffort" type="radio" :value="e.value" :disabled="!hasActiveProvider" />
              <span
                ><strong>{{ t(e.label) }}</strong
                ><em>{{ t(e.description) }}</em></span
              >
            </label>
          </div>
        </div>

        <div v-show="activeSettingsTab === 'mcp'" class="pt-5">
          <div class="settings-subhead">
            {{ t("settings.tabs.mcp") }} · {{ t("settings.mcpRegisteredCount", { count: mcpServers.length }) }}
          </div>
          <div class="mcp-list">
            <div v-for="server in mcpServers" :key="server.id" class="mcp-row">
              <span class="mcp-row__dot" :class="{ on: isMcpInstalled(server.id) }"></span>
              <div class="mcp-row__body">
                <strong>{{ server.name }}</strong>
                <span>{{ server.id }} · MCP</span>
              </div>
              <Switch :model-value="isMcpInstalled(server.id)" @update:model-value="toggleMcp(server.id)" />
            </div>
          </div>
          <p v-if="!mcpServers.length" class="footnote">
            {{ t("settings.mcpEmpty") }}
          </p>
        </div>

        <div v-show="activeSettingsTab === 'general'" class="pt-5">
          <div class="settings-grid settings-grid--single">
            <div class="setting-card">
              <div class="setting-card__head">
                <strong>{{ t("settings.language.label") }}</strong>
              </div>
              <Select v-model="settings.locale" :options="languageOptions" trigger-class="h-8" />
            </div>
            <div class="setting-card">
              <div class="setting-card__head">
                <strong>{{ t("settings.themeLabel") }}</strong>
              </div>
              <Select v-model="settingsTheme" :options="themeOptions" trigger-class="h-8" />
            </div>
            <div class="setting-card">
              <div class="setting-card__head">
                <strong>{{ t("settings.currentReasoning") }}</strong>
              </div>
              <div class="chips">
                <Badge round type="info">{{ activeProviderEffort }}</Badge>
                <Badge round type="warning">{{ settingsTheme }}</Badge>
              </div>
            </div>
            <div class="setting-card">
              <div class="setting-card__head">
                <strong>{{ t("settings.permissionTierLabel") }}</strong>
              </div>
              <div class="chips">
                <Badge round type="info">{{ settings.permissionTier }}</Badge
                ><Badge round :type="settings.planMode ? 'success' : 'default'"
                  >{{ t("settings.planMode") }} {{ settings.planMode ? t("settings.on") : t("settings.off") }}</Badge
                >
              </div>
            </div>
            <div class="setting-card">
              <div class="setting-card__head">
                <strong>{{ t("settings.workspaceDir") }}</strong>
              </div>
              <Input v-model="settings.workspaceDir" :placeholder="t('settings.workspaceDirPlaceholder')" class="h-8 text-xs" />
            </div>
          </div>
          <div class="setting-card" data-testid="registry-panel">
            <div class="setting-card__head">
              <strong>{{ t("settings.registryTitle") }}</strong>
              <Badge round :type="builtinActive ? 'success' : 'warning'">{{
                builtinActive ? t("settings.coreBuiltinEnabled") : t("settings.coreBuiltinDisabled")
              }}</Badge>
            </div>
            <p class="footnote">{{ t("settings.registryHint") }}</p>
            <Button v-if="builtinActive" variant="destructive" size="sm" data-testid="deactivate-builtin" @click="toggleBuiltin(false)">{{
              t("settings.disableBuiltin")
            }}</Button>
            <Button v-else size="sm" data-testid="activate-builtin" @click="toggleBuiltin(true)">{{ t("settings.enableBuiltin") }}</Button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
