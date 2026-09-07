<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { setLocale } from "../i18n";
import { systemBackend, type SysInfo } from "../lib/system-backend";
import { useAgentStore } from "../stores/agent";
import { useChatStore } from "../stores/chat";
import { RUN_MODES, SANDBOX_MODES, PERMISSION_TIERS, recommendedSandboxMode, useSettingsStore } from "../stores/settings";
import Icon from "../components/Icon.vue";
import StorageSettings from "../components/StorageSettings.vue";
import McpPane from "../components/settings/McpPane.vue";
import SettingsSkills from "../components/settings/SettingsSkills.vue";

/**
 * 设置内容区：按 /settings/:section 分派子面板。导航在 SettingsSider（左侧栏）。
 * 字段直接写 settings store，变更即持久化。
 */
const route = useRoute();
const settings = useSettingsStore();
const agent = useAgentStore();
const chatStore = useChatStore();

const section = computed(() => String(route.params.section ?? "agent"));

const sectionMeta = [
  { key: "agent", title: "Agent", desc: "模型供应商与默认后端" },
  { key: "assistant", title: "助手", desc: "会话与助手默认行为" },
  { key: "appearance", title: "外观", desc: "主题与语言" },
  { key: "mode", title: "运行模式", desc: "执行档位与权限策略" },
  { key: "system", title: "系统", desc: "环境信息与沙盒" },
  { key: "mcp", title: "MCP", desc: "外部工具服务器：声明给 agent，由 agent 连接" },
  { key: "skills", title: "技能", desc: "工作区技能：安装 / 更新 / 卸载与官方市场" },
  { key: "storage", title: "存储", desc: "会话落盘与远端同步" },
  { key: "team", title: "团队", desc: "成员与协作空间" },
] as const;

const meta = computed(() => sectionMeta.find((item) => item.key === section.value) ?? sectionMeta[0]);

const activeProvider = computed(() => settings.modelProviders.find((provider) => provider.id === settings.selectedModelProviderId));

function applyLocale(locale: "zh-CN" | "en-US"): void {
  settings.locale = locale;
  setLocale(locale);
  settings.persist();
}

/** 系统诊断快照（桌面态从 Rust 拉取；浏览器态 null）。 */
const sysInfo = ref<SysInfo | null>(null);
const sysInfoFailed = ref(false);

onMounted(() => {
  void agent.refreshAgentDetection();
  if (!systemBackend.active()) return;
  void systemBackend
    .info()
    .then((info) => {
      sysInfo.value = info;
    })
    .catch((error: unknown) => {
      sysInfoFailed.value = true;
      console.error("[settings] 系统信息拉取失败", error);
    });
});

/** 权限三档中文名与说明（grey 外壳直接写字面量，不走 i18n key）。 */
const permTierLabels: Record<string, string> = {
  "read-only": "只读",
  workspace: "工作区",
  full: "完全访问",
};

const permTierDescs: Record<string, string> = {
  "read-only": "禁止一切写入与执行类操作，仅允许读取",
  workspace: "自动执行，写入仅限当前工作区文件夹内",
  full: "可读写任意路径，不设工作区边界",
};

const sandboxLabels: Record<string, string> = { off: "关闭", fs: "文件系统隔离", full: "隔离 + 网络" };

const sandboxDescs: Record<string, string> = {
  off: "直启 agent 进程，不做 OS 级隔离（进程边界 + 宿主权限守卫仍在）。",
  fs: "bwrap 包裹：系统路径只读、工作区可写、/tmp 隔离、网络关闭。需系统安装 bwrap。",
  full: "同文件系统隔离，但放行网络（agent 可联网搜索 / MCP）。",
};

/** 与当前权限档位配套的沙盒档位；不一致时给出联动入口。 */
const suggestedSandbox = computed(() => recommendedSandboxMode(settings.permissionTier));

function applyPermissionTier(tier: (typeof PERMISSION_TIERS)[number]["value"]): void {
  settings.permissionTier = tier;
  settings.persist();
}

function applySandboxMode(mode: (typeof SANDBOX_MODES)[number]["value"]): void {
  settings.sandboxMode = mode;
  settings.persist();
}

function onMaxParallelInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  if (Number.isInteger(raw)) settings.maxParallel = raw;
  settings.persist();
}

// ---------- 模型供应商编辑 ----------

/** 当前编辑中的供应商 id（跟随选中项）与字段草稿。 */
const providerDraftId = ref<string | null>(null);
const providerDraft = ref({ name: "", baseUrl: "", model: "", apiKeyEnv: "" });
/** 草稿相对 store 有未保存改动时置真（简单脏检查，切走即丢——字段少，不做自动保存）。 */
const providerDraftDirty = ref(false);

function syncProviderDraft(): void {
  const provider = settings.modelProviders.find((candidate) => candidate.id === providerDraftId.value);
  if (!provider) return;
  providerDraft.value = {
    name: provider.name,
    baseUrl: provider.baseUrl ?? "",
    model: provider.model ?? "",
    apiKeyEnv: provider.apiKeyEnv ?? "",
  };
  providerDraftDirty.value = false;
}

watch(
  activeProvider,
  (provider) => {
    if (!provider) return;
    providerDraftId.value = provider.id;
    syncProviderDraft();
  },
  { immediate: true },
);

function saveProviderDraft(): void {
  const current = settings.modelProviders.find((provider) => provider.id === providerDraftId.value);
  if (!current) return;
  settings.upsertModelProvider({
    ...current,
    name: providerDraft.value.name.trim() || current.name,
    baseUrl: providerDraft.value.baseUrl.trim(),
    model: providerDraft.value.model.trim(),
    apiKeyEnv: providerDraft.value.apiKeyEnv.trim(),
  });
  providerDraftDirty.value = false;
}

function addCustomProvider(): void {
  const id = `custom-${Date.now().toString(36)}`;
  settings.upsertModelProvider({
    id,
    name: "自定义供应商",
    kind: "custom",
    baseUrl: "",
    model: "",
    apiKeyEnv: "CUSTOM_LLM_API_KEY",
    enabled: true,
  });
  settings.selectModelProvider(id);
}

function removeActiveProvider(): void {
  if (providerDraftId.value === null) return;
  settings.removeModelProvider(providerDraftId.value);
  providerDraftId.value = null;
  providerDraftDirty.value = false;
}

// ---------- ACP 后端编辑（用户自配） ----------

/** 自配后端草稿：agentDraftOpen 打开编辑器；agentDraftId = null 表示新增，否则编辑该项。 */
const agentDraftOpen = ref(false);
const agentDraftId = ref<string | null>(null);
const agentDraft = ref({ name: "", command: "" });
const agentDraftError = ref<string | null>(null);

function startAgentAdd(): void {
  agentDraftId.value = null;
  agentDraftOpen.value = true;
  agentDraft.value = { name: "", command: "" };
  agentDraftError.value = null;
}

function startAgentEdit(id: string): void {
  const provider = agent.agentProviders.find((candidate) => candidate.id === id);
  if (!provider) return;
  agentDraftId.value = provider.id;
  agentDraftOpen.value = true;
  agentDraft.value = { name: provider.name, command: provider.command };
  agentDraftError.value = null;
}

function cancelAgentDraft(): void {
  agentDraftId.value = null;
  agentDraftOpen.value = false;
  agentDraftError.value = null;
}

function saveAgentDraft(): void {
  const failure =
    agentDraftId.value === null
      ? agent.addAgentProvider(agentDraft.value.name, agentDraft.value.command)
      : agent.updateAgentProvider(agentDraftId.value, agentDraft.value.name, agentDraft.value.command);
  if (failure) {
    agentDraftError.value = failure;
    return;
  }
  agentDraftId.value = null;
  agentDraftOpen.value = false;
  agentDraftError.value = null;
}

async function removeAgentDraft(): Promise<void> {
  if (agentDraftId.value === null) return;
  const failure = await agent.removeAgentProvider(agentDraftId.value);
  if (failure) {
    agentDraftError.value = failure;
    return;
  }
  agentDraftId.value = null;
  agentDraftOpen.value = false;
  agentDraftError.value = null;
}

// ---------- MCP 面板已抽离为 components/settings/McpPane.vue ----------
</script>

<template>
  <section class="mx-auto min-h-0 h-full w-full max-w-[720px] overflow-y-auto px-4 py-6 sm:px-6">
    <header class="mb-6">
      <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">{{ meta.title }}</h1>
      <p class="mt-1 text-[12px] text-dim2">{{ meta.desc }}</p>
    </header>

    <div class="flex flex-col gap-4">
      <template v-if="section === 'agent'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 flex items-center justify-between gap-2">
            <span class="text-[13px] font-medium text-foreground">默认模型供应商</span>
            <span class="flex gap-1.5">
              <button
                type="button"
                class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
                @click="addCustomProvider"
              >
                ＋ 新增供应商
              </button>
              <button
                type="button"
                class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
                @click="settings.resetModelProviders()"
              >
                恢复默认
              </button>
            </span>
          </div>
          <div class="flex flex-col gap-1.5">
            <button
              v-for="provider in settings.modelProviders"
              :key="provider.id"
              class="flex cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left transition-colors"
              :class="provider.id === settings.selectedModelProviderId ? 'border-line-2 bg-panel-2' : 'border-transparent hover:bg-panel-2'"
              @click="settings.selectModelProvider(provider.id)"
            >
              <Icon :name="provider.enabled ? 'check-one' : 'close-one'" :size="14" class="text-dim" />
              <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{{ provider.name }}</span>
              <span class="font-mono text-[11px] text-dim2">{{ provider.model }}</span>
            </button>
          </div>
        </div>
        <!-- 供应商编辑表单：API key 来自宿主进程环境变量，改完需重启应用生效 -->
        <div v-if="activeProvider" class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 flex items-center justify-between gap-2">
            <span class="text-[13px] font-medium text-foreground">编辑供应商</span>
            <span class="text-[10.5px] text-dim2">当前：{{ activeProvider.id }}</span>
          </div>
          <div class="flex flex-col gap-2.5">
            <label class="flex items-center gap-2">
              <span class="w-20 shrink-0 text-[11.5px] text-dim2">名称</span>
              <input
                v-model="providerDraft.name"
                class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-line-2"
                placeholder="供应商名称"
                @input="providerDraftDirty = true"
              />
            </label>
            <label class="flex items-center gap-2">
              <span class="w-20 shrink-0 text-[11.5px] text-dim2">Base URL</span>
              <input
                v-model="providerDraft.baseUrl"
                class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-line-2"
                placeholder="https://api.openai.com/v1"
                @input="providerDraftDirty = true"
              />
            </label>
            <label class="flex items-center gap-2">
              <span class="w-20 shrink-0 text-[11.5px] text-dim2">模型</span>
              <input
                v-model="providerDraft.model"
                class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-line-2"
                placeholder="gpt-4o / claude-sonnet-4-5"
                @input="providerDraftDirty = true"
              />
            </label>
            <label class="flex items-center gap-2">
              <span class="w-20 shrink-0 text-[11.5px] text-dim2">API Key 环境变量</span>
              <input
                v-model="providerDraft.apiKeyEnv"
                class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-line-2"
                placeholder="OPENAI_API_KEY"
                @input="providerDraftDirty = true"
              />
            </label>
            <p class="text-[10.5px] leading-relaxed text-dim2">
              Key 在桌面端从启动应用的 shell 环境变量读取：先
              <code class="font-mono">export {{ providerDraft.apiKeyEnv || "OPENAI_API_KEY" }}=…</code> 再从同一终端启动
              GreyWork。浏览器/演示模式不读环境变量。
            </p>
            <div class="flex items-center justify-between gap-2">
              <button
                type="button"
                class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel-2 px-2.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
                @click="removeActiveProvider"
              >
                删除该供应商
              </button>
              <div class="flex gap-1.5">
                <button
                  type="button"
                  class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
                  @click="syncProviderDraft"
                >
                  撤销
                </button>
                <button
                  type="button"
                  class="h-7 cursor-pointer rounded-[7px] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="!providerDraftDirty"
                  @click="saveProviderDraft"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-1.5 text-[13px] font-medium text-foreground">推理等级</div>
          <div class="text-[11px] text-dim2">当前 {{ activeProvider?.reasoningEffort ?? "auto" }}</div>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 flex items-center justify-between gap-2">
            <span class="text-[13px] font-medium text-foreground">ACP 后端（聊天 / 自动执行）</span>
            <button
              type="button"
              class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
              @click="startAgentAdd"
            >
              新增后端
            </button>
          </div>
          <div class="flex flex-col gap-1.5">
            <label
              v-for="provider in agent.agentProviders"
              :key="provider.id"
              class="flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-transparent px-3 py-2 transition-colors hover:bg-panel-2"
            >
              <input
                type="checkbox"
                class="size-4 cursor-pointer accent-[var(--accent)]"
                :checked="provider.enabled"
                @change="void agent.setAgentProviderEnabled(provider.id, ($event.target as HTMLInputElement).checked)"
              />
              <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{{ provider.name }}</span>
              <span class="max-w-[36%] truncate font-mono text-[11px] text-dim2">{{ provider.command }}</span>
              <span
                class="shrink-0 text-[11px]"
                :class="agent.providerInstalled(provider) === true ? 'text-accent' : 'text-dim2'"
                :title="provider.installHint ?? ''"
              >
                {{ agent.providerInstallLabel(provider) }}
              </span>
              <button
                v-if="agent.isCustomAgentProvider(provider.id)"
                type="button"
                class="shrink-0 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
                @click.stop="startAgentEdit(provider.id)"
              >
                编辑
              </button>
            </label>
          </div>
          <p class="mt-2 text-[11px] text-dim2">
            启用后出现在发送条上方的后端选择胶囊；停用当前后端会自动切回 Local。标「首次启动下载」的后端由 npx 按需拉取，无需预装。＋
            新增后端可填任意 ACP 启动命令（如
            <code class="font-mono">my-agent acp</code>）；自配后端仅限本机已安装的程序，含 shell 元字符的命令会被宿主拒绝。
          </p>
        </div>
        <!-- 自配后端编辑表单（新增 / 编辑共用；仅 custom-* 项可编辑删除） -->
        <div v-if="agentDraftOpen" class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">
            {{ agentDraftId === null ? "新增 ACP 后端" : "编辑 ACP 后端" }}
          </div>
          <div class="flex flex-col gap-2.5">
            <label class="flex items-center gap-2">
              <span class="w-20 shrink-0 text-[11.5px] text-dim2">名称</span>
              <input
                v-model="agentDraft.name"
                class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-line-2"
                placeholder="如 My Agent"
              />
            </label>
            <label class="flex items-center gap-2">
              <span class="w-20 shrink-0 text-[11.5px] text-dim2">启动命令</span>
              <input
                v-model="agentDraft.command"
                class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-line-2"
                placeholder="如 my-agent acp / npx -y @scope/pkg-acp"
              />
            </label>
            <p v-if="agentDraftError" class="text-[11px] text-destructive">{{ agentDraftError }}</p>
            <div class="flex items-center justify-between gap-2">
              <button
                v-if="agentDraftId !== null"
                type="button"
                class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel-2 px-2.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
                @click="void removeAgentDraft()"
              >
                删除
              </button>
              <div class="ml-auto flex gap-1.5">
                <button
                  type="button"
                  class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
                  @click="cancelAgentDraft"
                >
                  撤销
                </button>
                <button
                  type="button"
                  class="h-7 cursor-pointer rounded-[7px] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90"
                  @click="saveAgentDraft"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="section === 'assistant'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <label class="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="block text-[13px] font-medium text-foreground">Plan 模式</span>
              <span class="block text-[11px] text-dim2">发送前先出计划，确认后再执行</span>
            </span>
            <input
              v-model="settings.planMode"
              type="checkbox"
              class="size-4 cursor-pointer accent-[var(--accent)]"
              :aria-label="'Plan 模式'"
            />
          </label>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <label class="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="block text-[13px] font-medium text-foreground">速度加成</span>
              <span class="block text-[11px] text-dim2">加速 mock 管线响应（演示用）</span>
            </span>
            <input
              v-model="chatStore.speedBoost"
              type="checkbox"
              class="size-4 cursor-pointer accent-[var(--accent)]"
              :aria-label="'速度加成'"
            />
          </label>
        </div>
      </template>

      <template v-else-if="section === 'appearance'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">主题</div>
          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="mode in ['dark', 'light', 'system'] as const"
              :key="mode"
              class="flex cursor-pointer flex-col items-center gap-2 rounded-[10px] border border-line px-3 py-3 transition-colors"
              :class="settings.theme === mode ? 'bg-panel-2' : 'hover:bg-panel-2'"
              :aria-pressed="settings.theme === mode"
              @click="
                settings.theme = mode;
                settings.persist();
              "
            >
              <Icon :name="mode === 'dark' ? 'moon' : mode === 'light' ? 'sun' : 'refresh'" :size="16" class="text-dim" />
              <span class="text-[12px] text-foreground">{{ mode === "dark" ? "深色" : mode === "light" ? "浅色" : "跟随系统" }}</span>
            </button>
          </div>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">语言</div>
          <div class="flex gap-2">
            <button
              v-for="locale in ['zh-CN', 'en-US'] as const"
              :key="locale"
              class="flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-line px-3 py-1.5 text-[12px] transition-colors"
              :class="settings.locale === locale ? 'bg-panel-2 text-foreground' : 'text-dim hover:bg-panel-2'"
              @click="applyLocale(locale)"
            >
              {{ locale === "zh-CN" ? "中文" : "English" }}
            </button>
          </div>
        </div>
      </template>

      <template v-else-if="section === 'mode'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">运行模式</div>
          <div class="flex flex-col gap-1.5">
            <button
              v-for="mode in RUN_MODES"
              :key="mode.value"
              class="flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-panel-2"
              :class="settings.runMode === mode.value ? 'bg-panel-2' : ''"
              @click="settings.runMode = mode.value"
            >
              <span class="text-[13px] text-foreground">{{ mode.label }}</span>
              <span class="text-[11px] text-dim2">{{ mode.hint }}</span>
            </button>
          </div>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">权限档位</div>
          <div class="flex gap-2">
            <button
              v-for="tier in PERMISSION_TIERS"
              :key="tier.value"
              class="flex flex-1 cursor-pointer flex-col gap-1 rounded-[10px] border border-line px-3 py-2.5 text-left transition-colors"
              :class="settings.permissionTier === tier.value ? 'bg-panel-2' : 'hover:bg-panel-2'"
              :aria-pressed="settings.permissionTier === tier.value"
              @click="applyPermissionTier(tier.value)"
            >
              <span class="text-[12px] font-medium text-foreground">{{ permTierLabels[tier.value] }}</span>
              <span class="text-[11px] leading-[1.5] text-dim2">{{ permTierDescs[tier.value] }}</span>
            </button>
          </div>
          <p v-if="settings.permissionTier === 'full'" class="mt-2 text-[11px] text-amber-400">
            完全访问不设工作区边界：agent 可读写任意路径。建议配合沙盒「{{
              sandboxLabels[suggestedSandbox]
            }}」，或用下面的临时只读跑高风险回合。
          </p>
          <label class="mt-3 flex cursor-pointer items-center justify-between gap-3 border-t border-line-2 pt-3">
            <span>
              <span class="block text-[13px] font-medium text-foreground">临时只读</span>
              <span class="block text-[11px] text-dim2">在途会话立即降为只读，跑完再关掉回到基线档位（不持久化）</span>
            </span>
            <input
              v-model="settings.tempReadOnly"
              data-testid="temp-readonly-toggle"
              type="checkbox"
              class="size-4 cursor-pointer accent-[var(--accent)]"
              aria-label="临时只读"
              @change="void agent.applyPermissionTier()"
            />
          </label>
          <p class="mt-2 text-[11px] text-dim">
            当前生效档位：{{ permTierLabels[settings.effectivePermissionTier] }}
            <span v-if="settings.tempReadOnly">（基线 {{ permTierLabels[settings.permissionTier] }} 已临时降级）</span>
          </p>
        </div>
      </template>

      <template v-else-if="section === 'system'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">关于</div>
          <div v-if="sysInfo" class="flex flex-col gap-1 font-mono text-[11px] text-dim2">
            <div class="flex justify-between">
              <span>版本</span><span class="text-foreground">{{ sysInfo.version }}</span>
            </div>
            <div class="flex justify-between">
              <span>数据 schema</span><span class="text-foreground">v{{ sysInfo.schemaVersion }}</span>
            </div>
            <div class="flex justify-between">
              <span>活跃 ACP 后端</span><span class="text-foreground">{{ sysInfo.activeAgents }}</span>
            </div>
            <div class="flex justify-between">
              <span>宿主 OS</span><span class="text-foreground">{{ sysInfo.os }}</span>
            </div>
            <div v-if="sysInfo.logDir" class="mt-1 flex flex-col gap-0.5">
              <span>日志目录</span>
              <span class="break-all text-dim">{{ sysInfo.logDir }}</span>
            </div>
          </div>
          <div v-else class="text-[11px] text-dim2">
            {{ sysInfoFailed ? "系统信息拉取失败（见控制台日志）" : "浏览器预览：无宿主诊断面。" }}
          </div>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-1 text-[13px] font-medium text-foreground">沙盒</div>
          <p class="mb-3 text-[11px] leading-[1.6] text-dim2">
            沙盒档位与权限档位是两条独立边界：权限三档是宿主在 ACP 工具调用层的<b class="font-medium text-dim">授权</b>判定（越界直接拒），
            沙盒档位是 bwrap 在 <b class="font-medium text-dim">OS 层</b>的隔离（进程连看都看不到）。两者互不替代 —— 「完全访问 +
            沙盒关闭」等于没有任何边界。
          </p>
          <div class="flex flex-col gap-1.5">
            <button
              v-for="mode in SANDBOX_MODES"
              :key="mode.value"
              class="flex cursor-pointer items-start justify-between gap-3 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-panel-2"
              :class="settings.sandboxMode === mode.value ? 'bg-panel-2' : ''"
              :aria-pressed="settings.sandboxMode === mode.value"
              @click="applySandboxMode(mode.value)"
            >
              <span class="min-w-0">
                <span class="block text-[13px] text-foreground">{{ sandboxLabels[mode.value] }}</span>
                <span class="block text-[11px] leading-[1.5] text-dim2">{{ sandboxDescs[mode.value] }}</span>
              </span>
              <Icon :name="settings.sandboxMode === mode.value ? 'check-one' : 'close-one'" :size="14" class="mt-0.5 shrink-0 text-dim" />
            </button>
          </div>
          <div v-if="settings.sandboxMode !== suggestedSandbox" class="mt-3 flex items-center gap-2 border-t border-line-2 pt-3">
            <span class="min-w-0 flex-1 text-[11px] text-dim">
              当前权限档位「{{ permTierLabels[settings.permissionTier] }}」建议沙盒「{{ sandboxLabels[suggestedSandbox] }}」
            </span>
            <button
              type="button"
              data-testid="sandbox-recommend"
              class="flex h-7 shrink-0 cursor-pointer items-center rounded-[8px] border border-line-2 bg-panel-2 px-3 text-[12px] text-foreground transition-colors hover:border-cyan"
              @click="applySandboxMode(suggestedSandbox)"
            >
              按权限档位联动
            </button>
          </div>
        </div>
      </template>

      <template v-else-if="section === 'mcp'">
        <McpPane />
      </template>

      <template v-else-if="section === 'skills'">
        <SettingsSkills />
      </template>

      <template v-else-if="section === 'storage'">
        <StorageSettings />
      </template>

      <template v-else-if="section === 'team'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="text-[13px] font-medium text-fg">编排并发度</div>
          <p class="mt-1 text-[12px] text-dim2">多智能体协作时同时运行的回合上限；调高可加速但需要更多进程资源。</p>
          <div class="mt-3 flex items-center gap-3">
            <input
              type="range"
              min="1"
              max="8"
              step="1"
              :value="settings.maxParallel"
              data-testid="max-parallel"
              class="h-1 w-48 cursor-pointer accent-accent"
              @input="onMaxParallelInput"
            />
            <span class="w-6 text-center text-[13px] font-medium text-fg" data-testid="max-parallel-value">{{ settings.maxParallel }}</span>
          </div>
          <p class="mt-2 text-[11px] text-dim2">范围 1–8，默认 2。更改即时生效。</p>
        </div>
      </template>
    </div>
  </section>
</template>
