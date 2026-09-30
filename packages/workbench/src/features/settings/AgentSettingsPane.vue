<script setup lang="ts">
/**
 * 设置 · agent 分区：默认模型供应商 + ACP 后端列表与编辑。
 * 字段直接写 settings/agent store，变更即持久化。
 */
import { computed, ref, watch } from "vue";
import { agentProviderIcon, agentProviderLobeIcon, REASONING_EFFORTS, type AgentProviderConfig } from "@greywork/shell";
import { createLlmClient } from "@greywork/llm";
import AgentProviderIcon from "@/features/conversation/AgentProviderIcon.vue";
import Hint from "@/features/shared/Hint.vue";
import IconPicker from "@/features/shared/IconPicker.vue";
import AgentProviderFormDialog, { type AgentProviderDraftPayload } from "@/features/settings/AgentProviderFormDialog.vue";
import ModelProviderFormDialog, { type ModelProviderDraftPayload } from "@/features/settings/ModelProviderFormDialog.vue";
import { formatHeaderText, parseHeaderText } from "@/stores/agent/shared";
import { useAgentStore } from "@/stores/agent";
import { useCommandCapabilitiesStore } from "@/stores/command-capabilities";
import { useSettingsStore } from "@/stores/settings";
import { runtimeMode } from "@greywork/host-ipc";
import { i18n } from "@/i18n";

const t = i18n.global.t;

const settings = useSettingsStore();
const agent = useAgentStore();

const capabilities = useCommandCapabilitiesStore();
void capabilities.ensureCatalog();

/**
 * 服务端 agent 目录只读：db_agents_sync 在服务端被禁（后端启动命令属于不可信输入）。
 *
 * 与写路径同一判据 —— unknown（能力表还没拉到）也按只读，免得「先能点、过一会变灰」的
 * 状态跳变。图标是 localStorage 覆盖层、不走这条命令，保持可改。
 */
const agentCatalogReadOnly = computed(() => runtimeMode() === "server" && capabilities.available("db_agents_sync") !== true);

const activeProvider = computed(() => settings.modelProviders.find((provider) => provider.id === settings.selectedModelProviderId));

// ---------- 模型供应商编辑 ----------

/** 当前编辑中的供应商 id（跟随选中项）与字段草稿。 */
const providerDraftId = ref<string | null>(null);
const providerDraft = ref({ name: "", baseUrl: "", model: "", apiKeyEnv: "", headersText: "", temperature: "", maxTokens: "" });
/** 草稿相对 store 有未保存改动时置真（简单脏检查，切走即丢——字段少，不做自动保存）。 */
const providerDraftDirty = ref(false);
/** Headers 文本解析错误（保存前就地拦截，不写进库）。 */
const providerDraftError = ref<string | null>(null);

/** 模型清单（拉取后填充模型输入的 datalist，兼作连通性自检）。 */
const llmClient = createLlmClient();
const modelOptions = ref<string[]>([]);
const probing = ref(false);
const probeError = ref<string | null>(null);

function syncProviderDraft(): void {
  const provider = settings.modelProviders.find((candidate) => candidate.id === providerDraftId.value);
  if (!provider) return;
  providerDraft.value = {
    name: provider.name,
    baseUrl: provider.baseUrl ?? "",
    model: provider.model ?? "",
    apiKeyEnv: provider.apiKeyEnv ?? "",
    headersText: formatHeaderText(provider.headers),
    temperature: provider.temperature === undefined ? "" : String(provider.temperature),
    maxTokens: provider.maxTokens === undefined ? "" : String(provider.maxTokens),
  };
  providerDraftDirty.value = false;
  providerDraftError.value = null;
  modelOptions.value = [];
  probeError.value = null;
}

/**
 * 拉取 `/models` 模型清单：既填下拉，也是连通性自检（能列出来 = Base URL 可达 + 鉴权正确）。
 * 用草稿里的连接信息而不是已保存的，方便「改完地址先测再存」。
 */
async function probeModels(): Promise<void> {
  if (!providerDraftId.value) return;
  probing.value = true;
  probeError.value = null;
  try {
    const parsed = parseHeaderText(providerDraft.value.headersText);
    if (parsed.error) {
      probeError.value = parsed.error;
      return;
    }
    modelOptions.value = await llmClient.listModels({
      baseUrl: providerDraft.value.baseUrl.trim(),
      apiKeyEnv: providerDraft.value.apiKeyEnv.trim(),
      headers: Object.keys(parsed.headers).length > 0 ? parsed.headers : undefined,
    });
    if (modelOptions.value.length === 0) probeError.value = "服务返回了空的模型清单";
  } catch (error) {
    probeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    probing.value = false;
  }
}

/** 解析可选数值输入（空串 = 不设置）；越界/非法就地报错，不写进库。 */
function parseOptionalNumber(raw: string, min: number, max: number, label: string): { value?: number; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min || value > max) {
    return { error: `${label} 需在 ${min}–${max} 之间` };
  }
  return { value };
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
  // 请求头在保存前解析：非法行就地报错，不写进库（宿主发请求时还会解析一次占位符）。
  const parsed = parseHeaderText(providerDraft.value.headersText);
  if (parsed.error) {
    providerDraftError.value = parsed.error;
    return;
  }
  const temperature = parseOptionalNumber(providerDraft.value.temperature, 0, 2, "温度");
  if (temperature.error) {
    providerDraftError.value = temperature.error;
    return;
  }
  const maxTokens = parseOptionalNumber(providerDraft.value.maxTokens, 1, 1_000_000, "最大 token");
  if (maxTokens.error) {
    providerDraftError.value = maxTokens.error;
    return;
  }
  settings.upsertModelProvider({
    ...current,
    name: providerDraft.value.name.trim() || current.name,
    baseUrl: providerDraft.value.baseUrl.trim(),
    model: providerDraft.value.model.trim(),
    apiKeyEnv: providerDraft.value.apiKeyEnv.trim(),
    headers: Object.keys(parsed.headers).length > 0 ? parsed.headers : undefined,
    temperature: temperature.value,
    maxTokens: maxTokens.value,
  });
  providerDraftDirty.value = false;
  providerDraftError.value = null;
}

/** 启用/停用一台模型供应商（此前列表只显示状态、无法开关，预设的 Ollama 因此用不起来）。 */
function setProviderEnabled(id: string, enabled: boolean): void {
  const provider = settings.modelProviders.find((candidate) => candidate.id === id);
  if (!provider) return;
  settings.upsertModelProvider({ ...provider, enabled });
}

/** 推理等级即时落盘（不入草稿脏检查：下拉改动即生效，与图标改动同一风格）。 */
function setProviderEffort(effort: string): void {
  const current = activeProvider.value;
  if (!current) return;
  settings.upsertModelProvider({ ...current, reasoningEffort: effort as (typeof REASONING_EFFORTS)[number]["value"] });
}

/** 新增供应商走弹窗：字段齐了再落库，避免「先建一条空供应商再补」的中间态。 */
const addProviderOpen = ref(false);
/** 同名供应商在列表里分不清，保存前在弹窗里就地拒绝。 */
const providerNames = computed(() => settings.modelProviders.map((provider) => provider.name));

function onAddProviderSave(payload: ModelProviderDraftPayload): void {
  const id = `custom-${Date.now().toString(36)}`;
  settings.upsertModelProvider({
    id,
    name: payload.name,
    kind: "custom",
    baseUrl: payload.baseUrl,
    model: payload.model,
    apiKeyEnv: payload.apiKeyEnv,
    headers: payload.headers,
    enabled: true,
  });
  settings.selectModelProvider(id);
  addProviderOpen.value = false;
}

function removeActiveProvider(): void {
  if (providerDraftId.value === null) return;
  settings.removeModelProvider(providerDraftId.value);
  providerDraftId.value = null;
  providerDraftDirty.value = false;
}

// ---------- ACP 后端编辑（用户自配） ----------

/** 自配后端弹窗：agentDialogEntry = null 表示新增，否则编辑该项。 */
const agentDialogOpen = ref(false);
const agentDialogEntry = ref<AgentProviderConfig | null>(null);
/** 落库失败（宿主校验等）回填到弹窗里，不关弹窗、不丢用户输入。 */
const agentDialogError = ref<string | null>(null);

/** 展开图标选择器的后端行（一次只开一个）。 */
const providerIconTarget = ref<string | null>(null);

function toggleProviderIcon(id: string): void {
  providerIconTarget.value = providerIconTarget.value === id ? null : id;
}

/** 图标改动即时落盘（走 store 的覆盖层）：没有保存按钮，改完就是改完。 */
function pickProviderIcon(id: string, icon: string): void {
  agent.setAgentProviderIcon(id, icon || null);
}

function startAgentAdd(): void {
  agentDialogEntry.value = null;
  agentDialogError.value = null;
  agentDialogOpen.value = true;
}

function startAgentEdit(id: string): void {
  const provider = agent.agentProviders.find((candidate) => candidate.id === id);
  if (!provider) return;
  agentDialogEntry.value = provider;
  agentDialogError.value = null;
  agentDialogOpen.value = true;
}

function closeAgentDialog(): void {
  agentDialogEntry.value = null;
  agentDialogError.value = null;
  agentDialogOpen.value = false;
}

function saveAgentDraft(payload: AgentProviderDraftPayload): void {
  const entry = agentDialogEntry.value;
  const failure = entry
    ? agent.updateAgentProvider(entry.id, payload.name, payload.command, payload.icon, payload.env)
    : agent.addAgentProvider(payload.name, payload.command, payload.icon, payload.env);
  if (failure) {
    agentDialogError.value = failure;
    return;
  }
  closeAgentDialog();
}

async function removeAgentDraft(): Promise<void> {
  const entry = agentDialogEntry.value;
  if (!entry) return;
  const failure = await agent.removeAgentProvider(entry.id);
  if (failure) {
    agentDialogError.value = failure;
    return;
  }
  closeAgentDialog();
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <span class="text-[13px] font-medium text-foreground">默认模型供应商</span>
        <span class="flex gap-1.5">
          <button
            type="button"
            class="h-6 cursor-pointer rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
            @click="addProviderOpen = true"
          >
            ＋ 新增供应商
          </button>
          <button
            type="button"
            class="h-6 cursor-pointer rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
            @click="settings.resetModelProviders()"
          >
            恢复默认
          </button>
        </span>
      </div>
      <div class="flex flex-col gap-1.5">
        <div
          v-for="provider in settings.modelProviders"
          :key="provider.id"
          class="flex items-center gap-2.5 rounded-[calc(10px*var(--gw-radius-scale))] border px-3 py-2 transition-colors"
          :class="provider.id === settings.selectedModelProviderId ? 'border-line-2 bg-panel-2' : 'border-transparent hover:bg-panel-2'"
        >
          <input
            type="checkbox"
            class="size-4 cursor-pointer accent-[var(--accent)]"
            :checked="provider.enabled"
            :aria-label="`启用 ${provider.name}`"
            :data-testid="`provider-enable-${provider.id}`"
            @change="setProviderEnabled(provider.id, ($event.target as HTMLInputElement).checked)"
          />
          <button
            type="button"
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
            @click="settings.selectModelProvider(provider.id)"
          >
            <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{{ provider.name }}</span>
            <span class="font-mono text-[11px] text-dim2">{{ provider.model }}</span>
          </button>
        </div>
      </div>
    </div>
    <!-- 供应商编辑表单：API key 来自宿主进程环境变量，改完需重启应用生效 -->
    <div v-if="activeProvider" class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <span class="text-[13px] font-medium text-foreground">编辑供应商</span>
        <span class="text-[10.5px] text-dim2">当前：{{ activeProvider.id }}</span>
      </div>
      <div class="flex flex-col gap-2.5">
        <label class="flex items-center gap-2">
          <span class="w-20 shrink-0 text-[11.5px] text-dim2">名称</span>
          <input
            v-model="providerDraft.name"
            class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-line-2"
            placeholder="供应商名称"
            @input="providerDraftDirty = true"
          />
        </label>
        <label class="flex items-center gap-2">
          <span class="w-20 shrink-0 text-[11.5px] text-dim2">Base URL</span>
          <input
            v-model="providerDraft.baseUrl"
            class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-line-2"
            placeholder="https://api.openai.com/v1"
            @input="providerDraftDirty = true"
          />
        </label>
        <label class="flex items-center gap-2">
          <span class="w-20 shrink-0 text-[11.5px] text-dim2">模型</span>
          <input
            v-model="providerDraft.model"
            list="provider-model-options"
            class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-line-2"
            placeholder="gpt-4o / qwen2.5"
            @input="providerDraftDirty = true"
          />
          <button
            type="button"
            class="h-7 shrink-0 cursor-pointer rounded-[calc(7px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="probing"
            :data-testid="`provider-probe-${activeProvider?.id ?? ''}`"
            :title="'连上服务并拉取模型清单（同时校验 Base URL / 鉴权）'"
            @click="probeModels"
          >
            {{ probing ? "拉取中…" : "拉取模型" }}
          </button>
        </label>
        <datalist id="provider-model-options">
          <option v-for="option in modelOptions" :key="option" :value="option" />
        </datalist>
        <p v-if="probeError" class="text-[11px] text-dim2" data-testid="provider-probe-error">
          {{ probeError }}
        </p>
        <p v-else-if="modelOptions.length > 0" class="text-[11px] text-dim2" data-testid="provider-probe-ok">
          已从服务取到 {{ modelOptions.length }} 个模型，点模型输入框可下拉选择。
        </p>
        <label class="flex items-center gap-2">
          <span class="w-20 shrink-0 text-[11.5px] text-dim2">API Key 环境变量</span>
          <input
            v-model="providerDraft.apiKeyEnv"
            class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-line-2"
            placeholder="OPENAI_API_KEY"
            @input="providerDraftDirty = true"
          />
        </label>
        <p class="text-[10.5px] leading-relaxed text-dim2">
          Key 在桌面端从启动应用的 shell 环境变量读取：先
          <code class="font-mono">export {{ providerDraft.apiKeyEnv || "OPENAI_API_KEY" }}=…</code> 再从同一终端启动
          GreyWork。浏览器/演示模式不读环境变量。
        </p>
        <label class="flex gap-2">
          <span class="w-20 shrink-0 pt-1.5 text-[11.5px] text-dim2">自定义 Headers</span>
          <textarea
            v-model="providerDraft.headersText"
            rows="3"
            spellcheck="false"
            class="min-w-0 flex-1 resize-y rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[11.5px] text-foreground outline-none placeholder:text-dim2 focus:border-line-2"
            placeholder="每行一条 Key: Value，如 X-Custom-Auth: {{MY_TOKEN}}"
            data-testid="provider-draft-headers"
            @input="providerDraftDirty = true"
          />
        </label>
        <p class="text-[10.5px] leading-relaxed text-dim2">
          附加到每次模型请求的 HTTP 头（自定义网关的鉴权 / 标记头）。敏感值写
          <code v-pre class="font-mono">{{ ENV_VAR }}</code> 占位符，发送时由宿主从环境变量解析，绝不明文落盘；空行与
          <code class="font-mono">#</code> 开头的行忽略。
        </p>
        <div class="flex items-center gap-2">
          <span class="w-20 shrink-0 text-[11.5px] text-dim2">采样温度</span>
          <input
            v-model="providerDraft.temperature"
            inputmode="decimal"
            data-testid="provider-temperature"
            class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-line-2"
            placeholder="留空 = 不传（如 0.2）"
            @input="providerDraftDirty = true"
          />
          <span class="w-20 shrink-0 text-[11.5px] text-dim2">最大 token</span>
          <input
            v-model="providerDraft.maxTokens"
            inputmode="numeric"
            data-testid="provider-max-tokens"
            class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-line-2"
            placeholder="留空 = 不传"
            @input="providerDraftDirty = true"
          />
        </div>
        <p class="text-[10.5px] leading-relaxed text-dim2">
          采样参数缺省不发送（由服务端默认值决定）。本地模型（Ollama / vLLM 等）常用温度 0–0.7、最大 token 限长。
        </p>
        <p v-if="providerDraftError" class="text-[11px] text-destructive">{{ providerDraftError }}</p>
        <div class="flex items-center justify-between gap-2">
          <button
            type="button"
            class="h-7 cursor-pointer rounded-[calc(7px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
            @click="removeActiveProvider"
          >
            删除该供应商
          </button>
          <div class="flex gap-1.5">
            <button
              type="button"
              class="h-7 cursor-pointer rounded-[calc(7px*var(--gw-radius-scale))] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
              @click="syncProviderDraft"
            >
              撤销
            </button>
            <button
              type="button"
              class="h-7 cursor-pointer rounded-[calc(7px*var(--gw-radius-scale))] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!providerDraftDirty"
              @click="saveProviderDraft"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4">
      <div class="mb-1.5 text-[13px] font-medium text-foreground">推理等级</div>
      <select
        data-testid="provider-effort-select"
        class="cursor-pointer rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-line-2"
        :value="activeProvider?.reasoningEffort ?? 'auto'"
        :aria-label="`设置 ${activeProvider?.name ?? ''} 的推理等级`"
        @change="setProviderEffort(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="effort in REASONING_EFFORTS" :key="effort.value" :value="effort.value">{{ t(effort.label) }}</option>
      </select>
      <div class="mt-1.5 text-[11px] text-dim2">
        {{ t(REASONING_EFFORTS.find((effort) => effort.value === (activeProvider?.reasoningEffort ?? "auto"))?.description ?? "") }}
      </div>
    </div>
    <div class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <span class="text-[13px] font-medium text-foreground">ACP 后端（聊天 / 自动执行）</span>
        <button
          v-if="!agentCatalogReadOnly"
          type="button"
          data-testid="agent-catalog-add"
          class="h-6 cursor-pointer rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          @click="startAgentAdd"
        >
          新增后端
        </button>
      </div>
      <!-- 服务端把 agent 目录钉成只读（db_agents_sync 被禁）：新增/编辑/启停都不给点，
           否则改动只落在浏览器本地、与服务端数据库悄悄分叉 —— 这比直接不能用更糟。 -->
      <p
        v-if="agentCatalogReadOnly"
        data-testid="agent-catalog-readonly"
        class="mb-2 rounded-[calc(10px*var(--gw-radius-scale))] bg-panel-2 px-3 py-2 text-[11px] leading-[1.6] text-dim2"
      >
        服务端模式下 agent 目录只读：这里的新增、编辑与启停不会生效。后端能否启动由服务端配置
        （GREYWORK_AGENT_PROGRAMS）管理，如需调整请修改服务端配置或联系管理员。
      </p>
      <div class="flex flex-col gap-1.5">
        <div v-for="provider in agent.agentProviders" :key="provider.id">
          <label
            class="flex cursor-pointer items-center gap-2.5 rounded-[calc(10px*var(--gw-radius-scale))] border border-transparent px-3 py-2 transition-colors hover:bg-panel-2"
          >
            <!-- 图标直接给人看的就是这枚：点它即换，故做成按钮而不是静态装饰 -->
            <Hint
              :text="
                provider.icon
                  ? `当前自定义图标：${agentProviderIcon(provider)}（点击换一个）`
                  : agentProviderLobeIcon(provider)
                    ? `当前品牌图标：${agentProviderLobeIcon(provider)?.slug}（点击可自定义）`
                    : `当前图标：${agentProviderIcon(provider)}（点击换一个）`
              "
              multiline
            >
              <button
                type="button"
                :data-testid="`agent-icon-${provider.id}`"
                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel-2 text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                :aria-expanded="providerIconTarget === provider.id"
                :aria-label="`改 ${provider.name} 的图标`"
                @click.stop="toggleProviderIcon(provider.id)"
              >
                <AgentProviderIcon :provider="provider" :size="13" />
              </button>
            </Hint>
            <input
              type="checkbox"
              class="size-4 accent-[var(--accent)]"
              :class="agentCatalogReadOnly ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'"
              :checked="provider.enabled"
              :disabled="agentCatalogReadOnly"
              :aria-label="`启用 ${provider.name}`"
              :data-testid="`agent-enable-${provider.id}`"
              @change="void agent.setAgentProviderEnabled(provider.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{{ provider.name }}</span>
            <span class="max-w-[36%] truncate font-mono text-[11px] text-dim2">{{ provider.command }}</span>
            <Hint :text="provider.installHint ?? null" multiline>
              <span class="shrink-0 text-[11px]" :class="agent.providerInstalled(provider) === true ? 'text-accent' : 'text-dim2'">
                {{ agent.providerInstallLabel(provider) }}
              </span>
            </Hint>
            <button
              v-if="agent.isCustomAgentProvider(provider.id) && !agentCatalogReadOnly"
              type="button"
              class="shrink-0 cursor-pointer rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
              @click.stop="startAgentEdit(provider.id)"
            >
              编辑
            </button>
          </label>
          <div
            v-if="providerIconTarget === provider.id"
            class="mb-1 ml-3 rounded-[calc(10px*var(--gw-radius-scale))] border border-line bg-panel-2 p-2"
            data-testid="agent-icon-picker"
          >
            <IconPicker
              :model-value="provider.icon ?? ''"
              :columns="10"
              clearable
              clear-label="默认"
              @update:model-value="pickProviderIcon(provider.id, $event)"
            />
          </div>
        </div>
      </div>
      <p class="mt-2 text-[11px] text-dim2">
        启用后出现在发送条上方的后端选择胶囊；停用当前后端会自动切回 Local。标「首次启动下载」的后端由 npx 按需拉取，无需预装。＋
        新增后端可填任意 ACP 启动命令（如
        <code class="font-mono">my-agent acp</code>
        ）；自配后端仅限本机已安装的程序，含 shell 元字符的命令会被宿主拒绝。每行的图标可随时点开更换（预设后端也可换），图标只影响展示。
      </p>
    </div>
    <ModelProviderFormDialog
      :open="addProviderOpen"
      :existing-names="providerNames"
      @save="onAddProviderSave"
      @cancel="addProviderOpen = false"
    />

    <!-- 自配后端弹窗（新增 / 编辑共用；仅 custom-* 项有编辑入口） -->
    <AgentProviderFormDialog
      :open="agentDialogOpen"
      :entry="agentDialogEntry"
      :error="agentDialogError"
      @save="saveAgentDraft"
      @remove="void removeAgentDraft()"
      @cancel="closeAgentDialog"
    />
  </div>
</template>
