<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { MCP_SKIP_REASONS } from "@/lib/mcp-labels";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore, type PermTier } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type { Attachment, ThreadMessage } from "@/types";
import AcpSessionConfig from "@/features/conversation/AcpSessionConfig.vue";
import AgentProviderBar from "@/features/conversation/AgentProviderBar.vue";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import ContextMenuRegion from "@/features/shared/ContextMenuRegion.vue";
import {
  buildComposerItems,
  buildMessageItems,
  type ComposerMenuActions,
  type ContextMenuItem,
  type ContextTarget,
} from "@/lib/context-menu";
import { copyText } from "@/lib/clipboard";
import { copySelection, cutSelection, hasTextSelection, pasteInto, selectAllText } from "@/lib/textarea-actions";
import ConversationMessage from "@/features/conversation/ConversationMessage.vue";
import SessionStatusIndicator from "@/features/shared/SessionStatusIndicator.vue";
import PermissionCard from "@/features/conversation/PermissionCard.vue";
import AttachmentTray from "@/features/conversation/AttachmentTray.vue";
import SlashCommandMenu from "@/features/conversation/SlashCommandMenu.vue";
import { useAttachments } from "@/lib/use-attachments";
import { useChatReceiver } from "@/lib/use-chat-receiver";
import { useSessionStatus } from "@/lib/session-status";
import { useTurnActive } from "@/lib/turn-activity";
import { dispatchIntent } from "@/lib/dispatch-intent";
import { useSlashCommands } from "@/lib/use-slash-commands";
import { materializeAttachments } from "@/state/attachment-library";

/**
 * GreyWork 风格对话页：消息流 + 底部输入卡。
 * 路由参数 conversationId → 会话（缺省空建）→ chat.activeThreadId。
 */
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const agent = useAgentStore();
const chat = useChatStore();
const sessionStore = useSessionStore();
const settings = useSettingsStore();
const workspaceStore = useWorkspaceStore();

const draft = ref("");
const scrollEl = ref<HTMLElement | null>(null);
/** 钉底锚定（虚拟列表用）：默认底部；syncActive 切会话时重置为 true。 */
const pinnedToBottom = ref(true);

const sessionId = computed(() => {
  const raw = route.params.conversationId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return id ?? "";
});

const session = computed(() => (sessionId.value ? sessionStore.getSession(sessionId.value) : undefined));
const messages = computed<ThreadMessage[]>(() => (sessionId.value ? sessionStore.ensure(sessionId.value) : []));

/** 会话状态（未开始 / 运行 / 等待中 / 结束）：由运行时信号实时派生。 */
const statusOf = useSessionStatus();
const status = computed(() => (sessionId.value ? statusOf(sessionId.value) : "idle"));

/** 当前运行后端展示名：ACP agent（routeToAcp 开启时）或 Local LLM。 */
const backendLabel = computed(() => {
  if (!agent.routeToAcp) return "Local";
  const provider = agent.agentProviders.find((candidate) => candidate.id === agent.selectedProviderId);
  return provider?.name ?? "ACP";
});
/** 运行中：LLM 流或 ACP 回合任一活跃（含 spawn/建会话在途 —— 那窗口也要能停）。
 *  判定收在 lib/turn-activity，消息行 / 计划卡 / 提问卡 / 会话状态读同一份。 */
const turnActive = useTurnActive();

function stop(): void {
  if (agent.acpBusy || agent.acpConnecting || agent.acpStatus === "connecting") void agent.stopAcp();
  else chat.abortGeneration();
}

const workspaceName = computed(() => {
  const workspace = workspaceStore.workspaces.find((workspace) => workspace.id === session.value?.workspaceId);
  return workspace?.name ?? "普通对话";
});

/** 头部 MCP 胶囊：本会话建立时实际声明成功的服务器数（0 且有跳过项时提示被跳过）。 */
const mcpChipLabel = computed(() =>
  agent.acpMcpServers.length > 0 ? `MCP · ${agent.acpMcpServers.join(" · ")}` : `MCP 未生效（${agent.acpMcpSkipped.length}）`,
);
const mcpChipTitle = computed(() => {
  const lines = agent.acpMcpServers.length > 0 ? [`已声明给 agent：${agent.acpMcpServers.join("、")}`] : [];
  for (const skip of agent.acpMcpSkipped) lines.push(`已跳过 ${skip.name}：${MCP_SKIP_REASONS[skip.reason] ?? skip.reason}`);
  return lines.join("\n");
});

function syncActive(): void {
  if (!sessionId.value) {
    const created = sessionStore.createSession(workspaceStore.activeWorkspaceId);
    void router.replace(`/conversation/${created.id}`);
    return;
  }
  sessionStore.setActive(sessionId.value);
  chat.activeThreadId = sessionId.value;
  // 切会话回到底部锚定
  pinnedToBottom.value = true;
}
watch(sessionId, syncActive, { immediate: true });

function scrollToBottom(): void {
  void nextTick(() => scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight }));
}

/* ===== 消息列表虚拟化 =====
 * 短会话（≤ VIRTUAL_THRESHOLD 条）走普通整列渲染（简单、无测量抖动）；
 * 长会话切成动态测量虚拟列表（@tanstack/vue-virtual），只挂载可视窗口 ± overscan。
 * 钉底语义：用户停留在底部附近时，新消息/流式长高自动跟底；上翻阅读时不被拽走。 */
const VIRTUAL_THRESHOLD = 60;
const V_PAD_TOP = 24; // 对齐原 py-6 顶距
const V_PAD_BOTTOM = 24; // 对齐原 py-6 底距
const useVirtual = computed(() => messages.value.length > VIRTUAL_THRESHOLD);

/** 动态 options：count 随消息数变化（vue-virtual 以 Ref<options> 驱动重建）。 */
const virtualOptions = computed(() => ({
  getScrollElement: () => scrollEl.value,
  count: useVirtual.value ? messages.value.length : 0,
  estimateSize: () => 72,
  overscan: 8,
  getItemKey: (index: number) => messages.value[index]?.id ?? index,
}));
const virtualizerRef = useVirtualizer(virtualOptions);

/** 虚拟容器总高：各行测量高 + 上下留白。 */
const virtualTotalHeight = computed(() => (useVirtual.value ? virtualizerRef.value.getTotalSize() + V_PAD_TOP + V_PAD_BOTTOM : 0));

function measureRow(element: unknown): void {
  if (element instanceof HTMLElement) virtualizerRef.value.measureElement(element);
}

function onScroll(): void {
  if (!useVirtual.value) return;
  const el = scrollEl.value;
  if (!el) return;
  // 距底 < 48px 视为「钉底」；上翻即解除，直到再次滚回底部
  pinnedToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

/** 滚动触发：新增消息 / 末条正文或末段思考在长 / 虚拟行尺寸刷新。普通列表维持历史「恒滚底」行为。 */
const lastMessageSig = computed(() => {
  const last = messages.value[messages.value.length - 1];
  if (!last) return "";
  const tail = last.segments?.at(-1);
  return `${last.content.length}:${last.segments?.length ?? 0}:${tail?.kind === "thinking" ? tail.text.length : 0}`;
});
watch(
  [() => messages.value.length, lastMessageSig, () => virtualizerRef.value.getTotalSize()],
  () => {
    if (useVirtual.value) {
      if (pinnedToBottom.value) scrollToBottom();
    } else {
      scrollToBottom();
    }
  },
  { flush: "post" },
);

/** 图片可用性：本地 LLM 无能力声明（交给供应商报错），ACP 以 agent 声明为准。 */
const imagesAllowed = computed(() => !agent.routeToAcp || agent.acpImageSupport !== false);
const attachments = useAttachments(() => sessionId.value || chat.activeThreadId, { imagesAllowed: () => imagesAllowed.value });
const {
  items: attachmentItems,
  dragging: attachmentDragging,
  full: attachmentsFull,
  attachEl,
  pick: pickAttachmentFiles,
  onPaste: onComposerPaste,
  onDragOver: onComposerDragOver,
  onDragLeave: onComposerDragLeave,
  onDrop: onComposerDrop,
  remove: removeAttachment,
  take: takeAttachments,
} = attachments;

/** 斜杠命令菜单：内置动作 + ACP 命令；发送复用既有 send() 语义（附件 / 计划模式 / 后端路由）。 */
const textareaEl = ref<HTMLTextAreaElement | null>(null);
const {
  open: slashOpen,
  items: slashItems,
  activeIndex: slashActiveIndex,
  activeOptionId: slashActiveOptionId,
  handleKeydown: handleSlashKeydown,
  select: selectSlashCommand,
  dismiss: dismissSlashMenu,
} = useSlashCommands({
  draft,
  textarea: textareaEl,
  onSend: (text) => {
    draft.value = text;
    send();
  },
  canSend: () => !turnActive.value,
});

// 本视图能接收对话注入：注册接收方（预览划词工具条据此判断可用）+ 挂附件桥与预填桥。
// 网页正文「发送到对话」与划词工具条都走这条线，落到同一份附件草稿。
useChatReceiver({ draft, textarea: textareaEl, attachments });

/**
 * 带附件的派发：先把草稿落进会话附件库（路径化存储），再交给统一分流点
 * （计划门 / 编排判定 / 后端路由都在 lib/dispatch-intent，别在这里重写一遍）。
 * 落库失败会以内联数据降级，附件不会丢。
 */
async function dispatchWithAttachments(text: string, items: readonly Attachment[]): Promise<void> {
  const threadId = sessionId.value || chat.activeThreadId;
  const ready = items.length ? await materializeAttachments(threadId, items) : [...items];
  await dispatchIntent(text, ready, { planGate: true, allowOrchestrate: true });
}

function send(): void {
  if (!canSend.value) return;
  const text = draft.value.trim();
  const items = attachmentItems.value.length ? takeAttachments() : [];
  void dispatchWithAttachments(text, items);
  draft.value = "";
  scrollToBottom();
}

function onKeydown(event: KeyboardEvent): void {
  // 斜杠菜单打开时先由它消费方向键 / Enter / Tab / Esc（含 IME 放行）。
  if (handleSlashKeydown(event)) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

function goBack(): void {
  void router.push("/guid");
}

/** 发送按钮可用：有文字或附件，且当前回合不在跑（斜杠菜单与按钮共用同一判定）。 */
const canSend = computed(() => !turnActive.value && (draft.value.trim().length > 0 || attachmentItems.value.length > 0));

/** 权限档位胶囊文案（grey 外壳字面量，不走 i18n）。 */
const PERM_TIER_LABELS: Record<PermTier, string> = {
  "read-only": "只读",
  workspace: "工作区",
  full: "完全访问",
};
const permissionTierLabel = computed(() => PERM_TIER_LABELS[settings.permissionTier] ?? settings.permissionTier);

/* ===== 右键菜单 =====
 * 整页只挂一个 root（<section> 没有 ref，可安全当 trigger）：
 * - 消息 article 标 data-ctx="message"，按 id 回查正文；
 * - 输入框标 data-ctx="composer"，提供剪切/复制/粘贴/全选。
 *
 * 刻意**不**包 scrollEl / textarea：reka 的 asChild 会丢弃子元素自身的 ref
 * （reka Primitive/Slot.js 里 `delete props.ref`），包了会让 scrollEl / textareaEl 变 null，
 * 钉底滚动与斜杠命令都会失效。单 root 同时也避免了嵌套 trigger 双开。
 */
function composerActions(): ComposerMenuActions {
  const el = textareaEl.value;
  return {
    cut: () => void cutSelection(el),
    copy: () => void copySelection(el),
    paste: () => void pasteInto(el),
    selectAll: () => selectAllText(el),
    hasSelection: hasTextSelection(el),
  };
}

function buildMenu(target: ContextTarget | null): ContextMenuItem[] {
  if (target?.ctx === "message") {
    const id = target.el.dataset.messageId;
    const message = messages.value.find((candidate) => candidate.id === id);
    return buildMessageItems(message?.content ?? null, t, { copyBody: (text) => void copyText(text) });
  }
  if (target?.ctx === "composer") return buildComposerItems(t, composerActions());
  // 页头 / 空白处：不弹自定义菜单（同时把原生菜单拦掉）。
  return [];
}
</script>

<template>
  <ContextMenuRegion :build="buildMenu">
    <section class="flex h-full min-h-0 flex-col">
      <div class="flex h-[46px] shrink-0 items-center gap-2 border-b border-line-2 bg-panel px-3">
        <button
          class="grid size-7 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          aria-label="返回"
          @click="goBack"
        >
          <Icon name="arrow-left" :size="16" />
        </button>
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13px] font-medium text-foreground">{{ session?.title ?? "新对话" }}</div>
          <div class="truncate text-[10px] text-dim2">{{ workspaceName }}</div>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <SessionStatusIndicator :status="status" chip />
          <span class="flex h-5 items-center gap-1 rounded-full border border-line bg-panel-2 px-2 text-[10.5px] text-dim">
            <Icon name="robot" :size="10" />
            {{ backendLabel }}
          </span>
          <span class="flex h-5 items-center gap-1 rounded-full border border-line bg-panel-2 px-2 text-[10.5px] text-dim">
            <Icon name="shield" :size="10" />
            {{ permissionTierLabel }}
          </span>
          <Hint v-if="agent.acpMcpServers.length || agent.acpMcpSkipped.length" :text="mcpChipTitle" multiline>
            <span
              class="flex h-5 items-center gap-1 rounded-full border border-line px-2 text-[10.5px]"
              :class="agent.acpMcpServers.length ? 'bg-cyan/10 text-cyan' : 'bg-panel-2 text-dim2'"
              data-testid="session-mcp-chip"
            >
              <Icon name="earth" :size="10" />
              {{ mcpChipLabel }}
            </span>
          </Hint>
          <button
            v-if="turnActive"
            type="button"
            class="flex h-6 cursor-pointer items-center gap-1 rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
            @click="stop"
          >
            <Icon name="close-one" :size="11" />
            停止
          </button>
        </div>
      </div>

      <div ref="scrollEl" class="min-h-0 flex-1 overflow-y-auto" @scroll.passive="onScroll">
        <!-- 短会话：普通整列渲染 -->
        <div v-if="messages.length && !useVirtual" class="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-4 py-6 sm:px-6">
          <ConversationMessage v-for="message in messages" :key="message.id" :message="message" :thread-id="sessionId" />
        </div>
        <!-- 长会话：虚拟窗口渲染（动态测量高度，钉底跟流） -->
        <div
          v-else-if="messages.length"
          class="relative mx-auto w-full max-w-[860px] px-4 sm:px-6"
          :style="{ height: `${virtualTotalHeight}px` }"
        >
          <div
            v-for="row in virtualizerRef.getVirtualItems()"
            :key="String(row.key)"
            :ref="measureRow"
            :data-index="row.index"
            class="absolute left-0 top-0 w-full pb-4"
            :style="{ transform: `translateY(${row.start + V_PAD_TOP}px)` }"
          >
            <ConversationMessage :message="messages[row.index]" :thread-id="sessionId" />
          </div>
        </div>
        <!-- 空会话引导 -->
        <div
          v-else
          class="mx-auto flex h-full w-full max-w-[860px] flex-col items-center justify-center gap-2 px-4 py-16 text-center sm:px-6"
        >
          <span class="grid size-10 place-items-center rounded-[12px] bg-panel-2 text-dim">
            <Icon name="message" :size="18" />
          </span>
          <p class="text-[13px] font-medium text-foreground">{{ t("chat.composer.emptyTitle") }}</p>
          <p class="text-[12px] text-dim2">{{ t("chat.composer.emptyHint") }}</p>
        </div>
      </div>

      <div class="shrink-0 border-t border-line-2 bg-panel px-4 py-3 sm:px-6">
        <div class="mx-auto flex w-full max-w-[860px] flex-col gap-2.5">
          <PermissionCard />
          <AgentProviderBar />
          <div
            ref="attachEl"
            data-attachment-dropzone
            data-testid="composer-card"
            class="relative flex w-full flex-col gap-2 rounded-[16px] border bg-panel-2 p-3 shadow-[0_8px_24px_rgba(0,0,0,0.1)] transition-[border-color,box-shadow] focus-within:border-cyan/50 focus-within:shadow-[0_10px_28px_rgba(0,0,0,0.14)]"
            :class="attachmentDragging ? 'border-cyan ring-2 ring-cyan/40' : 'border-line-2'"
            @dragover="onComposerDragOver"
            @dragleave="onComposerDragLeave"
            @drop="onComposerDrop"
          >
            <AttachmentTray :items="attachmentItems" @remove="removeAttachment" />
            <!-- outline-none 在这里是真生效的：base.css 的全局焦点环放在 @layer base 里，
               能被 @layer utilities 的 .outline-none 盖掉。焦点反馈由外层卡片的 focus-within 承担。 -->
            <textarea
              ref="textareaEl"
              v-model="draft"
              data-ctx="composer"
              rows="3"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="slashOpen"
              :aria-controls="slashOpen ? 'slash-command-menu' : undefined"
              :aria-activedescendant="slashActiveOptionId"
              class="min-h-[76px] w-full resize-none rounded-[10px] bg-panel px-2.5 py-2 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-dim"
              :placeholder="t('chat.composer.placeholderThread')"
              :aria-label="t('chat.composer.ariaLabel')"
              @keydown="onKeydown"
              @blur="dismissSlashMenu"
              @paste="onComposerPaste"
            />
            <div class="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-line/70 px-2 pt-2" data-testid="composer-config-row">
              <span v-if="agent.routeToAcp" class="mr-0.5 text-[10px] font-medium tracking-[0.08em] text-dim2">会话配置</span>
              <AcpSessionConfig />
            </div>
            <div class="flex items-center justify-between gap-2" data-testid="composer-action-row">
              <div class="flex min-w-0 items-center gap-1.5">
                <Hint :text="imagesAllowed ? t('chat.uploadFile') : t('chat.attachImagesUnsupported')" multiline>
                  <button
                    type="button"
                    data-testid="composer-attach"
                    class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
                    :disabled="turnActive || attachmentsFull"
                    :aria-label="t('chat.uploadFile')"
                    @click="pickAttachmentFiles"
                  >
                    <Icon name="plus" :size="14" />
                  </button>
                </Hint>
                <span class="shrink-0 text-[11px] text-dim2">
                  {{ turnActive ? t("chat.composer.processing") : t("chat.composer.ready") }}
                </span>
                <Hint v-if="settings.planMode" :text="t('chat.planModeTitle')" multiline>
                  <button
                    type="button"
                    data-testid="composer-plan-chip"
                    class="flex h-5 shrink-0 cursor-pointer items-center rounded-full border border-line bg-panel px-2 text-[10.5px] text-dim transition-colors hover:text-foreground"
                    @click="settings.planMode = false"
                  >
                    {{ t("chat.planMode") }}
                  </button>
                </Hint>
                <Hint v-if="chat.speedBoost" :text="t('chat.speedTitle')" multiline>
                  <button
                    type="button"
                    data-testid="composer-speed-chip"
                    class="flex h-5 shrink-0 cursor-pointer items-center rounded-full border border-line bg-panel px-2 text-[10.5px] text-dim transition-colors hover:text-foreground"
                    @click="chat.speedBoost = false"
                  >
                    {{ t("chat.speedBoost") }}
                  </button>
                </Hint>
              </div>
              <button
                data-testid="composer-send"
                class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] border border-accent bg-accent px-3 text-[12px] font-medium text-accent-ink transition-[background-color,border-color,color,opacity] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:border-line-2 disabled:bg-panel disabled:text-dim2 disabled:opacity-100"
                :disabled="!canSend"
                @click="send"
              >
                {{ t("chat.send") }}
                <Icon name="send-one" :size="13" />
              </button>
            </div>
            <SlashCommandMenu
              v-if="slashOpen"
              :items="slashItems"
              :active-index="slashActiveIndex"
              @select="selectSlashCommand"
              @update:active-index="slashActiveIndex = $event"
            />
          </div>
        </div>
      </div>
    </section>
  </ContextMenuRegion>
</template>
