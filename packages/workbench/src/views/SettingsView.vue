<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  REASONING_EFFORTS,
  createCliSessionManager,
  createDefaultCliIntegrations,
  type CliIntegration,
  type ReasoningEffort,
} from "@greywork/shell";
import { Brain, Cpu, Plug, Settings2, Terminal } from "lucide-vue-next";
import { capabilitySeam } from "../plugins/loader";
import { Button, Badge, DataTable, Input, Select, Switch, type TableColumn } from "../components/ui";
import { useSettingsStore, type ThemeMode } from "../stores/settings";
import { getPluginMarket, persistRegisteredMcp, removeRegisteredMcp } from "../state/pluginMarket";
import { PROVIDER_TONES } from "../lib/tones";

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
  { value: "providers" as const, label: "模型供应商", icon: Cpu },
  { value: "cli" as const, label: "CLI 接入", icon: Terminal },
  { value: "reasoning" as const, label: "推理等级", icon: Brain },
  { value: "mcp" as const, label: "MCP 服务器", icon: Plug },
  { value: "general" as const, label: "通用", icon: Settings2 },
];

const cliIntegrations = ref<CliIntegration[]>(createDefaultCliIntegrations());
const cliSessionManager = createCliSessionManager();
const cliSessions = ref(
  cliSessionManager.list().map((session) => ({
    ...session,
    statusLabel: session.status === "running" ? "运行中" : "已结束",
  })),
);
const reasoningEffort = ref<ReasoningEffort>("medium");
const settingsTheme = computed<ThemeMode>({
  get: () => settings.theme,
  set: (value) => {
    settings.theme = value;
  },
});
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
  { label: "自定义", value: "custom" },
];
const reasoningOptions = REASONING_EFFORTS.map((item) => ({ label: item.label, value: item.value }));
const themeOptions = [
  { label: "深色", value: "dark" },
  { label: "浅色", value: "light" },
  { label: "跟随系统", value: "system" },
];

const cliColumns: TableColumn[] = [
  { title: "CLI", key: "cliId", width: 120 },
  { title: "会话", key: "title" },
  { title: "状态", key: "status", width: 90 },
  { title: "操作", key: "statusLabel", width: 90 },
];

function addModelProvider(): void {
  settings.modelProviders.push({
    id: "custom-" + Date.now(),
    name: "自定义供应商",
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
  const cli = cliIntegrations.value.find((item) => item.id === cliId);
  cliSessionManager.start(cliId, (cli?.name ?? cliId) + " · 新会话");
  cliSessions.value = cliSessionManager.list().map((session) => ({
    ...session,
    statusLabel: session.status === "running" ? "运行中" : "已结束",
  }));
}

function saveSettings(): void {
  try {
    localStorage.setItem(
      "greywork.settings",
      JSON.stringify({
        reasoningEffort: reasoningEffort.value,
        theme: settings.theme,
        selectedModelProviderId: settings.selectedModelProviderId,
        cli: cliIntegrations.value,
        modelProviders: settings.modelProviders,
      }),
    );
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
        <h1 class="view__title">设置</h1>
        <p class="view__sub">模型供应商 · CLI 接入 · 推理等级 · MCP · 通用。</p>
      </div>
      <div class="view__actions">
        <span v-if="saveState === 'saved'" class="footnote">已保存</span>
        <span v-else-if="saveState === 'error'" class="footnote text-destructive">保存失败</span>
        <Button @click="saveSettings">保存设置</Button>
      </div>
    </div>
    <div class="settings-shell">
      <nav class="settings-nav" aria-label="设置分区">
        <button
          v-for="t in settingsTabs"
          :key="t.value"
          class="settings-nav__item"
          :class="{ active: activeSettingsTab === t.value }"
          @click="activeSettingsTab = t.value"
        >
          <component :is="t.icon" class="size-4" />
          {{ t.label }}
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
                  <span>{{ p.model || "未配置模型" }}</span>
                </div>
                <Badge :type="p.enabled ? 'success' : 'default'" round>{{ p.enabled ? "在线" : "停用" }}</Badge>
                <Switch v-model="p.enabled" />
              </div>
              <div class="setting-fields">
                <Input v-model="p.name" placeholder="名称" class="h-8 text-xs" />
                <Select v-model="p.kind" :options="providerKindOptions" trigger-class="h-8" />
                <Input v-model="p.baseUrl" placeholder="Base URL" class="h-8 text-xs" />
                <Input v-model="p.model" placeholder="模型（如 gpt-4o / claude-sonnet-4-5）" class="h-8 text-xs" />
                <Input v-model="p.apiKeyEnv" placeholder="API Key 环境变量" class="h-8 text-xs" />
                <Select v-model="p.reasoningEffort" :options="reasoningOptions" trigger-class="h-8" />
              </div>
              <Button variant="ghost" size="sm" @click="removeModelProvider(p.id)">删除</Button>
            </div>
          </div>
          <Button size="sm" @click="addModelProvider">新增供应商</Button>
        </div>

        <div v-show="activeSettingsTab === 'cli'" class="pt-5">
          <div class="settings-grid">
            <div v-for="c in cliIntegrations" :key="c.id" class="setting-card">
              <div class="setting-card__head">
                <Badge :type="c.available ? 'success' : 'warning'" round>{{ c.kind }}</Badge>
                <strong>{{ c.name }}</strong>
                <Button size="sm" @click="startCliSession(c.id)">启动会话</Button>
              </div>
              <div class="setting-fields">
                <Input v-model="c.command" placeholder="CLI 命令（如 opencode / claude / pi）" class="h-8 text-xs" />
                <Select v-model="c.reasoningEffort" :options="reasoningOptions" trigger-class="h-8" />
              </div>
            </div>
          </div>
          <div class="settings-subhead">CLI 会话</div>
          <DataTable :columns="cliColumns" :data="cliSessions" class="text-xs" />
        </div>

        <div v-show="activeSettingsTab === 'reasoning'" class="pt-5">
          <div class="reasoning-list">
            <label v-for="e in REASONING_EFFORTS" :key="e.value" class="reasoning-item">
              <input v-model="reasoningEffort" type="radio" :value="e.value" />
              <span
                ><strong>{{ e.label }}</strong
                ><em>{{ e.description }}</em></span
              >
            </label>
          </div>
        </div>

        <div v-show="activeSettingsTab === 'mcp'" class="pt-5">
          <div class="settings-subhead">MCP 服务器 · {{ mcpServers.length }} 个已登记</div>
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
            尚无登记的 MCP 服务器 —— 在「插件市场」搜索官方 MCP Registry（如 github / filesystem / sqlite）登记后，可在此处开关。
          </p>
        </div>

        <div v-show="activeSettingsTab === 'general'" class="pt-5">
          <div class="settings-grid settings-grid--single">
            <div class="setting-card">
              <div class="setting-card__head"><strong>主题</strong></div>
              <Select v-model="settingsTheme" :options="themeOptions" trigger-class="h-8" />
            </div>
            <div class="setting-card">
              <div class="setting-card__head"><strong>当前推理等级</strong></div>
              <div class="chips">
                <Badge round type="info">{{ reasoningEffort }}</Badge>
                <Badge round type="warning">{{ settingsTheme }}</Badge>
              </div>
            </div>
            <div class="setting-card">
              <div class="setting-card__head"><strong>权限档位</strong></div>
              <div class="chips">
                <Badge round type="info">{{ settings.permissionTier }}</Badge
                ><Badge round :type="settings.planMode ? 'success' : 'default'">计划模式 {{ settings.planMode ? "开" : "关" }}</Badge>
              </div>
            </div>
            <div class="setting-card">
              <div class="setting-card__head"><strong>ACP 工作区目录</strong></div>
              <Input v-model="settings.workspaceDir" placeholder="留空 = 桌面主目录（宿主校验绝对路径且非根）" class="h-8 text-xs" />
            </div>
          </div>
          <div class="setting-card" data-testid="registry-panel">
            <div class="setting-card__head">
              <strong>能力注册表</strong>
              <Badge round :type="builtinActive ? 'success' : 'warning'">{{
                builtinActive ? "core.builtin 已启用" : "core.builtin 已停用"
              }}</Badge>
            </div>
            <p class="footnote">一切皆插件：内置清单贡献全部 mode 与面板槽位；停用后画布摘除全部标签，路由访问将回退。</p>
            <Button v-if="builtinActive" variant="destructive" size="sm" data-testid="deactivate-builtin" @click="toggleBuiltin(false)"
              >停用 core.builtin</Button
            >
            <Button v-else size="sm" data-testid="activate-builtin" @click="toggleBuiltin(true)">启用 core.builtin</Button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
