<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { runtimeMode } from "@greywork/host-ipc";
import { useAgentStore } from "@/stores/agent";
import { useCommandCapabilitiesStore } from "@/stores/command-capabilities";
import { useNoticeStore } from "@/stores/notice";
import { useWorkspaceStore } from "@/stores/workspace";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import AcpSessionConfig from "@/features/conversation/AcpSessionConfig.vue";
import AgentProviderIcon from "@/features/conversation/AgentProviderIcon.vue";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 极简模式输入卡（参考截图：chips 行 + 分隔线 + 文本区 + 动作行，同处一个圆角容器内）。
 *
 * **不碰会话 / 派发管线**：草稿归属、提交、附件、斜杠命令、选区评论全部由 GuidView 经
 * props + 具名 slot 注入 —— 「新建会话 → 分流 → 派发」这条链只有一份实现（`GuidView.run`），
 * 不会因为多出一个输入卡而漂移。本组件只负责**就地可用的配置**：
 *
 * - 主卡：chips 行（工作区切换器）+ 文本区 + 动作行（`＋` 附件、Agent 后端切换器、发送键）。
 * - 主卡**下方**另起一块圆角 + 阴影的 ACP 会话配置（复用 `AcpSessionConfig`，routeToAcp 时自渲染）。
 * - slots：`#tray`（附件 / 评论草稿托盘）、`#menu`（斜杠菜单）由宿主注入。
 */
const props = defineProps<{
  modelValue: string;
  /** 回合进行中：右侧显示忙碌指示 */
  busy: boolean;
  /** 是否可以发送（由 GuidView 结合文字 + 附件算好）；为假时发送键置灰 */
  canSend: boolean;
  placeholder: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  submit: [];
  attach: [];
  keydown: [event: KeyboardEvent];
  paste: [event: ClipboardEvent];
  blur: [];
}>();

const { t } = useI18n();
const agent = useAgentStore();
const workspaceStore = useWorkspaceStore();
const notices = useNoticeStore();
const capabilities = useCommandCapabilitiesStore();
void capabilities.ensureCatalog();

/** 未绑定工作区（普通对话）在下拉里也要是一个可选项：reka 的 radio value 只吃字符串，故用哨兵。 */
const GENERAL_WORKSPACE = "__general__";

/** 当前工作区（下拉选中态 + 胶囊文案）。 */
const activeWorkspace = computed(
  () => workspaceStore.workspaces.find((workspace) => workspace.id === workspaceStore.activeWorkspaceId) ?? null,
);
const workspaceName = computed(() => activeWorkspace.value?.name ?? null);

/** 当前 ACP 后端（routeToAcp 时）；胶囊文案取它的名字，本地则显示 Local。 */
const activeProvider = computed(() =>
  agent.routeToAcp ? (agent.agentProviders.find((provider) => provider.id === agent.selectedProviderId) ?? null) : null,
);
const agentLabel = computed(() => (agent.routeToAcp ? (activeProvider.value?.name ?? t("minimal.agent")) : "Local"));

/**
 * 服务端 agent 目录只读（与 AgentProviderBar 同一判据）。此时不代用户「顺手启用」——
 * 静默改状态又写不进服务端，不如让选择失败并把「未启用」说清楚。判据单一来源见
 * features/conversation/AgentProviderBar.vue（那里是权威实现）。
 */
const agentCatalogReadOnly = computed(() => runtimeMode() === "server" && capabilities.available("db_agents_sync") !== true);

function pickWorkspace(value: string): void {
  workspaceStore.setActiveWorkspace(value === GENERAL_WORKSPACE ? null : value);
}

function pickLocal(): void {
  void agent.switchToLocalLlm();
}

/** 切换 ACP 后端：镜像 AgentProviderBar.selectAcp（未启用且目录可写则先启用，再连接）。 */
async function pickProvider(id: string): Promise<void> {
  const provider = agent.agentProviders.find((candidate) => candidate.id === id);
  if (provider && !provider.enabled && !agentCatalogReadOnly.value) await agent.setAgentProviderEnabled(id, true);
  if (id === agent.selectedProviderId && agent.routeToAcp && agent.acpConnected) return;
  const failure = await agent.activateAcpProvider(id);
  if (failure) notices.push({ kind: "error", title: t("minimal.agentSwitchFailed", { name: provider?.name ?? id }), detail: failure });
}

const textareaEl = ref<HTMLTextAreaElement | null>(null);
function focus(): void {
  textareaEl.value?.focus();
}
defineExpose({ focus });
</script>

<template>
  <!-- 外层列：主输入卡 + （ACP 时）独立的会话配置块。拖放属性 / 未声明监听透传到这一层。 -->
  <div data-testid="minimal-composer" class="flex w-full max-w-[760px] flex-col gap-2">
    <!-- 主输入卡 -->
    <div
      class="relative w-full rounded-[calc(16px*var(--gw-radius-scale))] border border-line-2 bg-panel-2 shadow-[0_10px_32px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow] focus-within:border-cyan/50 focus-within:shadow-[0_12px_36px_rgba(0,0,0,0.16)]"
    >
      <!-- chips 行：工作区切换（与截图一致，用分隔线与文本区分开） -->
      <div class="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-line/70 px-3 py-2" data-testid="minimal-composer-chips">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              data-testid="minimal-composer-workspace"
              class="flex h-6 max-w-[240px] cursor-pointer items-center gap-1 rounded-full border border-line bg-panel px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            >
              <Icon name="folder" :size="11" class="text-dim" />
              <span class="truncate whitespace-nowrap">{{ workspaceName ?? t("minimal.workspaceFallback") }}</span>
              <Icon name="down" :size="10" class="text-dim2" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" class="w-[220px] border-line">
            <DropdownMenuLabel class="px-2 py-1 text-[10.5px] font-medium tracking-wide text-dim2 uppercase">
              {{ t("minimal.workspaceLabel") }}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="workspaceStore.activeWorkspaceId ?? GENERAL_WORKSPACE">
              <!-- 普通对话：未绑定工作区的落点（哨兵 → setActiveWorkspace(null)） -->
              <DropdownMenuRadioItem
                :value="GENERAL_WORKSPACE"
                data-testid="minimal-workspace-general"
                class="cursor-pointer gap-2 rounded-[calc(6px*var(--gw-radius-scale))] py-1.5 text-[12px]"
                :class="workspaceStore.activeWorkspaceId === null ? 'text-foreground' : 'text-dim'"
                @select="pickWorkspace(GENERAL_WORKSPACE)"
              >
                <template #indicator-icon><span></span></template>
                <Icon :name="workspaceStore.activeWorkspaceId === null ? 'check-one' : 'message'" :size="12" class="shrink-0 text-dim" />
                <span class="truncate">{{ t("minimal.workspaceFallback") }}</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                v-for="workspace in workspaceStore.workspaces"
                :key="workspace.id"
                :value="workspace.id"
                :data-testid="`minimal-workspace-${workspace.id}`"
                class="cursor-pointer gap-2 rounded-[calc(6px*var(--gw-radius-scale))] py-1.5 text-[12px]"
                :class="workspace.id === workspaceStore.activeWorkspaceId ? 'text-foreground' : 'text-dim'"
                @select="pickWorkspace(workspace.id)"
              >
                <template #indicator-icon><span></span></template>
                <Icon
                  :name="workspace.id === workspaceStore.activeWorkspaceId ? 'check-one' : (workspace.icon ?? 'folder')"
                  :size="12"
                  class="shrink-0 text-dim"
                />
                <span class="truncate">{{ workspace.name }}</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <!-- 附件 / 评论草稿托盘（由 GuidView 注入） -->
      <slot name="tray" />

      <textarea
        ref="textareaEl"
        :value="props.modelValue"
        data-ctx="composer"
        rows="2"
        role="combobox"
        aria-autocomplete="list"
        class="min-h-[64px] w-full resize-none bg-transparent px-3 py-3 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-dim"
        :placeholder="props.placeholder"
        :aria-label="t('chat.composer.ariaLabel')"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @keydown="emit('keydown', $event as KeyboardEvent)"
        @paste="emit('paste', $event as ClipboardEvent)"
        @blur="emit('blur')"
      />

      <div class="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
        <div class="flex min-w-0 items-center gap-1.5">
          <Hint :text="t('chat.uploadFile')">
            <button
              type="button"
              data-testid="minimal-composer-attach"
              class="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border border-line-2 text-dim transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              :aria-label="t('chat.uploadFile')"
              @click="emit('attach')"
            >
              <Icon name="plus" :size="14" />
            </button>
          </Hint>

          <!-- Agent 后端切换器：Local + 各 ACP 后端（与完整外壳的 AgentProviderBar 同一套选择语义） -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                data-testid="minimal-composer-agent"
                class="flex h-7 cursor-pointer items-center gap-1 rounded-full px-2 text-[11.5px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              >
                <AgentProviderIcon v-if="activeProvider" :provider="activeProvider" :size="13" />
                <Icon v-else name="terminal" :size="12" />
                <span class="max-w-[140px] truncate">{{ agentLabel }}</span>
                <Icon name="down" :size="10" class="text-dim2" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" class="w-[220px] border-line">
              <DropdownMenuLabel class="px-2 py-1 text-[10.5px] font-medium tracking-wide text-dim2 uppercase">
                {{ t("minimal.agentLabel") }}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup :model-value="agent.routeToAcp ? (agent.selectedProviderId ?? '__none__') : 'local'">
                <DropdownMenuRadioItem
                  value="local"
                  data-testid="minimal-agent-local"
                  class="cursor-pointer gap-2 rounded-[calc(6px*var(--gw-radius-scale))] py-1.5 text-[12px]"
                  :class="!agent.routeToAcp ? 'text-foreground' : 'text-dim'"
                  @select="pickLocal"
                >
                  <template #indicator-icon><span></span></template>
                  <Icon :name="!agent.routeToAcp ? 'check-one' : 'terminal'" :size="12" class="shrink-0 text-dim" />
                  <span class="truncate">Local</span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  v-for="provider in agent.agentProviders"
                  :key="provider.id"
                  :value="provider.id"
                  :data-testid="`minimal-agent-${provider.id}`"
                  class="cursor-pointer gap-2 rounded-[calc(6px*var(--gw-radius-scale))] py-1.5 text-[12px]"
                  :class="agent.routeToAcp && provider.id === agent.selectedProviderId ? 'text-foreground' : 'text-dim'"
                  @select="pickProvider(provider.id)"
                >
                  <template #indicator-icon><span></span></template>
                  <AgentProviderIcon :provider="provider" :size="13" />
                  <span class="min-w-0 flex-1 truncate">{{ provider.name }}</span>
                  <span v-if="!provider.enabled" class="shrink-0 text-[10px] text-dim2">{{ t("minimal.agentDisabled") }}</span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <span
            v-if="props.busy"
            data-testid="minimal-composer-busy"
            class="size-4 animate-spin rounded-full border-[1.5px] border-cyan border-t-transparent"
            :aria-label="t('chat.composer.processing')"
          />
          <button
            type="button"
            data-testid="minimal-composer-send"
            class="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-accent text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:bg-panel disabled:text-dim2"
            :disabled="!props.canSend"
            :aria-label="t('chat.send')"
            @click="emit('submit')"
          >
            <Icon name="send-one" :size="15" />
          </button>
        </div>
      </div>

      <!-- 斜杠菜单（由宿主注入，绝对定位在卡片内） -->
      <slot name="menu" />
    </div>

    <!-- ACP 会话配置：放在发送框**下方**，独立成块，圆角 + 阴影与主卡区分。
         复用完整外壳的 `AcpSessionConfig`（权限 / 模型 / 思考强度 / 会话模式 / 开关型配置 / 重启），
         它内部已按 routeToAcp 自守 —— 本地路由时整块不渲染，不留空盒。 -->
    <div
      v-if="agent.routeToAcp"
      data-testid="minimal-composer-config"
      class="flex min-w-0 flex-wrap items-center gap-1.5 rounded-[calc(12px*var(--gw-radius-scale))] border border-line-2 bg-panel px-3 py-2 shadow-[0_6px_18px_rgba(0,0,0,0.12)]"
    >
      <AcpSessionConfig />
    </div>
  </div>
</template>
