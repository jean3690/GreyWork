<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAgentStore } from "@/stores/agent";
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

/** 只列已启用的后端（与 AgentProviderBar 同一显隐语义：未启用的要先到设置里启用）。 */
const enabledProviders = computed(() => agent.agentProviders.filter((provider) => provider.enabled));

/* ===== ACP 会话配置块：默认收起 =====
 * 配置簇（作用域 / 模型 / 思考强度 / 开关 / 设默认 / 重启）完整铺开时块很高，会把输入卡
 * 顶得离消息流很远 —— 视觉噪声大且抢焦。默认收成一行摘要（当前模型名），要调才展开。
 * 收起态仍渲染 AcpSessionConfig（v-show 不卸载）：切换后端 / 重连时配置项变化要能即时反映，
 * 卸载重挂会丢掉展开态与面板焦点。 */
const configOpen = ref(false);

/** 收起态摘要：当前模型名（无值时回落到「跟随 CLI」占位），与 AcpModelSelector 同一取值口径。 */
const configSummary = computed(() => {
  const model = agent.acpConfigOptions.find((entry) => entry.id === "model" && entry.type === "select");
  const value = model?.currentValue;
  if (value === null || value === undefined || value === "") return t("minimal.configUnset");
  const choice = model?.options?.find((candidate) => String(candidate.value) === String(value));
  return choice?.name ?? String(value);
});

function toggleConfig(): void {
  configOpen.value = !configOpen.value;
}

function pickWorkspace(value: string): void {
  workspaceStore.setActiveWorkspace(value === GENERAL_WORKSPACE ? null : value);
}

/** 切换 ACP 后端：列表只放已启用的，启用动作在设置页完成。 */
async function pickProvider(id: string): Promise<void> {
  const provider = agent.agentProviders.find((candidate) => candidate.id === id);
  if (id === agent.selectedProviderId && agent.routeToAcp && agent.acpConnected) return;
  const failure = await agent.activateAcpProvider(id);
  if (failure) notices.push({ kind: "error", title: t("minimal.agentSwitchFailed", { name: provider?.name ?? id }), detail: failure });
}

/**
 * 宿主（`GuidView` / `ConversationView`）要拿到里面这颗 textarea：右键菜单的选区读写、
 * 斜杠菜单回焦、划词注入桥都直接操作 DOM，而元素现在归本组件所有。
 * 暴露 `textareaEl`（元素引用）与 `focus()`，宿主经模板 ref 读取。
 */
const textareaEl = ref<HTMLTextAreaElement | null>(null);
function focus(): void {
  textareaEl.value?.focus();
}
defineExpose({ focus, textareaEl });

/* ===== 文本区自适应高度 =====
 * 长指令（贴日志 / 多行 prompt）在固定 2 行高里只能看见末尾，回看开头得手动拽角。
 * 这里按 scrollHeight 逐行撑高，到 MAX_HEIGHT 封顶后转为内部滚动 —— 不让输入卡无限长高
 * 把消息流挤没。`height:auto` 先归零再量，否则只增不减（收行时不会回缩）。
 *
 * 受控组件，两个触发面都要覆盖：用户敲键盘（input）与外部改草稿（建议卡填入 / 取回待发）。 */
const MAX_HEIGHT = 176; // 约 6 行（14px * 1.6 行高 + 内边距），再多就该滚而不是继续撑
let resizeScheduled = false;

function resizeTextarea(): void {
  const el = textareaEl.value;
  if (!el || resizeScheduled) return;
  // input 事件里同步改 height 会被浏览器合批掉，丢到微任务末尾统一量一次
  resizeScheduled = true;
  void nextTick(() => {
    resizeScheduled = false;
    const target = textareaEl.value;
    if (!target) return;
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, MAX_HEIGHT)}px`;
  });
}

onMounted(resizeTextarea);
watch(() => props.modelValue, resizeTextarea);

/** 输入转发：先更新 v-model，再按新内容重算高度（顺序别反，量的是新值）。 */
function onTextareaInput(el: HTMLTextAreaElement): void {
  emit("update:modelValue", el.value);
  resizeTextarea();
}
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
        class="max-h-[176px] min-h-[64px] w-full resize-none overflow-y-auto bg-transparent px-3 py-3 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-dim"
        :placeholder="props.placeholder"
        :aria-label="t('chat.composer.ariaLabel')"
        @input="onTextareaInput($event.target as HTMLTextAreaElement)"
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

          <!-- Agent 后端切换器：只列各 ACP 后端（与完整外壳的 AgentProviderBar 同一套选择语义） -->
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
              <DropdownMenuRadioGroup :model-value="agent.routeToAcp ? (agent.selectedProviderId ?? '__none__') : ''">
                <DropdownMenuRadioItem
                  v-for="provider in enabledProviders"
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

    <!-- ACP 会话配置：放在发送框**下方**，独立成块。默认收起成一行摘要（当前模型），
         点开才铺开完整配置簇 —— 配置项多时整块很高，常驻铺开会把输入卡顶离消息流。
         复用 `AcpSessionConfig`（权限 / 模型 / 思考强度 / 会话模式 / 开关型配置 / 重启），
         它内部已按 routeToAcp 自守 —— 本地路由时整块不渲染，不留空盒。
         展开态用 v-show 而非 v-if：配置簇保持挂载，切换后端 / 重连时能即时反映，不会丢焦点。 -->
    <div
      v-if="agent.routeToAcp"
      data-testid="minimal-composer-config"
      class="min-w-0 rounded-[calc(12px*var(--gw-radius-scale))] border border-line-2 bg-panel shadow-[0_6px_18px_rgba(0,0,0,0.12)]"
    >
      <button
        type="button"
        data-testid="minimal-composer-config-toggle"
        class="flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-panel-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan"
        :aria-expanded="configOpen"
        :aria-label="configOpen ? t('minimal.configCollapse') : t('minimal.configExpand')"
        @click="toggleConfig"
      >
        <Icon name="setting" :size="11" class="shrink-0 text-dim2" />
        <span class="shrink-0 text-[11px] text-dim">{{ t("minimal.configLabel") }}</span>
        <span class="min-w-0 flex-1 truncate text-[11px] text-dim2">{{ configSummary }}</span>
        <Icon name="down" :size="10" class="shrink-0 text-dim2 transition-transform" :class="configOpen ? 'rotate-180' : ''" />
      </button>
      <div v-show="configOpen" class="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-line/70 px-3 py-2">
        <AcpSessionConfig />
      </div>
    </div>
  </div>
</template>
