<script setup lang="ts">
/**
 * 设置 · agent 分区：默认模型供应商 + ACP 后端列表与编辑。
 * 字段直接写 settings/agent store，变更即持久化。
 */
import { computed, ref, watch } from "vue";
import { agentProviderIcon, agentProviderLobeIcon } from "@greywork/shell";
import AgentProviderIcon from "@/features/conversation/AgentProviderIcon.vue";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import IconPicker from "@/features/shared/IconPicker.vue";
import { useAgentStore } from "@/stores/agent";
import { useSettingsStore } from "@/stores/settings";

const settings = useSettingsStore();
const agent = useAgentStore();

const activeProvider = computed(() => settings.modelProviders.find((provider) => provider.id === settings.selectedModelProviderId));

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
const agentDraft = ref({ name: "", command: "", icon: "" });
const agentDraftError = ref<string | null>(null);

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
  agentDraftId.value = null;
  agentDraftOpen.value = true;
  agentDraft.value = { name: "", command: "", icon: "" };
  agentDraftError.value = null;
}

function startAgentEdit(id: string): void {
  const provider = agent.agentProviders.find((candidate) => candidate.id === id);
  if (!provider) return;
  agentDraftId.value = provider.id;
  agentDraftOpen.value = true;
  agentDraft.value = { name: provider.name, command: provider.command, icon: provider.icon ?? "" };
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
      ? agent.addAgentProvider(agentDraft.value.name, agentDraft.value.command, agentDraft.value.icon || undefined)
      : agent.updateAgentProvider(agentDraftId.value, agentDraft.value.name, agentDraft.value.command, agentDraft.value.icon || undefined);
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
</script>

<template>
  <div class="flex flex-col gap-4">
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
        <div v-for="provider in agent.agentProviders" :key="provider.id">
          <label
            class="flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-transparent px-3 py-2 transition-colors hover:bg-panel-2"
          >
            <!-- 图标直接给人看的就是这枚：点它即换，故做成按钮而不是静态装饰 -->
            <Hint
              :text="
                provider.icon
                  ? `当前自定义图标：${agentProviderIcon(provider)}（点击换一个）`
                  : agentProviderLobeIcon(provider)
                    ? `当前品牌图标：@lobehub/icons/${agentProviderLobeIcon(provider)?.slug}（点击可自定义）`
                    : `当前图标：${agentProviderIcon(provider)}（点击换一个）`
              "
              multiline
            >
              <button
                type="button"
                :data-testid="`agent-icon-${provider.id}`"
                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] border border-line bg-panel-2 text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                :aria-expanded="providerIconTarget === provider.id"
                :aria-label="`改 ${provider.name} 的图标`"
                @click.stop="toggleProviderIcon(provider.id)"
              >
                <AgentProviderIcon :provider="provider" :size="13" />
              </button>
            </Hint>
            <input
              type="checkbox"
              class="size-4 cursor-pointer accent-[var(--accent)]"
              :checked="provider.enabled"
              :aria-label="`启用 ${provider.name}`"
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
              v-if="agent.isCustomAgentProvider(provider.id)"
              type="button"
              class="shrink-0 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
              @click.stop="startAgentEdit(provider.id)"
            >
              编辑
            </button>
          </label>
          <div
            v-if="providerIconTarget === provider.id"
            class="mb-1 ml-3 rounded-[10px] border border-line bg-panel-2 p-2"
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
        <div class="flex gap-2">
          <span class="w-20 shrink-0 pt-1.5 text-[11.5px] text-dim2">图标</span>
          <IconPicker v-model="agentDraft.icon" class="min-w-0 flex-1" :columns="12" clearable clear-label="默认" />
        </div>
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
  </div>
</template>
