<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { MCP_SKIP_REASONS } from "@/lib/mcp-labels";
import { deviceTier } from "@/lib/device-tier";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore, type PermTier } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { useNoticeStore } from "@/stores/notice";
import type { Attachment, MessageComment, ThreadMessage } from "@/types";
import MinimalComposer from "@/features/guid/MinimalComposer.vue";
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
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import SessionStatusIndicator from "@/features/shared/SessionStatusIndicator.vue";
import SubagentIndicator from "@/features/conversation/SubagentIndicator.vue";
import AttachmentTray from "@/features/conversation/AttachmentTray.vue";
import SlashCommandMenu from "@/features/conversation/SlashCommandMenu.vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAttachments } from "@/lib/use-attachments";
import { useChatReceiver } from "@/lib/use-chat-receiver";
import { useSessionStatus } from "@/lib/session-status";
import { useTurnActive } from "@/lib/turn-activity";
import { dispatchIntent } from "@/lib/dispatch-intent";
import { quoteSummary } from "@/lib/message-comments";
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
const notice = useNoticeStore();

const draft = ref("");
/** 选区评论草稿（预览划词 → 评论）：发送时挂到消息上，发后清空。 */
const comments = ref<MessageComment[]>([]);
const scrollEl = ref<HTMLElement | null>(null);
/** 钉底锚定（虚拟列表用）：默认底部；syncActive 切会话时重置为 true。 */
const pinnedToBottom = ref(true);
/** 会话回退目标：非 null 时挂确认弹层（见 performRewind）。 */
const rewindTarget = ref<ThreadMessage | null>(null);

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
 * 钉底语义：用户停留在底部附近时，新消息/流式长高自动跟底；上翻阅读时不被拽走。
 *
 * 低端设备（lib/device-tier.ts）：阈值减半、overscan 收到 3 —— 挂载行数直接决定 DOM
 * 与布局开销，少挂几屏是低内存机上最直接的省法；代价是快速滚动时更容易看到空白行，
 * 但比整窗卡顿可接受。options 是 computed，档位被宿主快照升级后会自行重建。 */
const VIRTUAL_THRESHOLD = computed(() => (deviceTier.value === "low" ? 30 : 60));
const V_PAD_TOP = 24; // 对齐原 py-6 顶距
const V_PAD_BOTTOM = 24; // 对齐原 py-6 底距
const useVirtual = computed(() => messages.value.length > VIRTUAL_THRESHOLD.value);

/** 动态 options：count 随消息数变化（vue-virtual 以 Ref<options> 驱动重建）。 */
const virtualOptions = computed(() => ({
  getScrollElement: () => scrollEl.value,
  count: useVirtual.value ? messages.value.length : 0,
  estimateSize: () => 72,
  overscan: deviceTier.value === "low" ? 3 : 8,
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
  pick: pickAttachmentFiles,
  onPaste: onComposerPaste,
  onDragOver: onComposerDragOver,
  onDragLeave: onComposerDragLeave,
  onDrop: onComposerDrop,
  remove: removeAttachment,
  take: takeAttachments,
} = attachments;

/**
 * 斜杠命令菜单：内置动作 + ACP 命令；发送复用既有 send() 语义（附件 / 计划模式 / 后端路由）。
 *
 * textarea 元素归 `MinimalComposer` 所有，宿主经它的模板 ref 读暴露出来的元素。
 * 右键菜单 / 划词注入 / 回焦都要这颗 DOM，所以这里只做一次转接，别处照旧读 `textareaEl`。
 */
const composerRef = ref<{ textareaEl: HTMLTextAreaElement | null } | null>(null);
const textareaEl = computed<HTMLTextAreaElement | null>(() => composerRef.value?.textareaEl ?? null);
const {
  open: slashOpen,
  items: slashItems,
  activeIndex: slashActiveIndex,
  handleKeydown: handleSlashKeydown,
  select: selectSlashCommand,
  dismiss: dismissSlashMenu,
} = useSlashCommands({
  draft,
  textarea: textareaEl,
  onSend: (text) => {
    draft.value = text;
    void send();
  },
  canSend: () => !turnActive.value,
});

// 本视图能接收对话注入：注册接收方（预览划词工具条据此判断可用）+ 挂附件桥与预填桥。
// 网页正文「发送到对话」与划词工具条都走这条线，落到同一份附件草稿。
useChatReceiver({ draft, textarea: textareaEl, attachments, comments });

/**
 * 带附件的派发：先把草稿落进会话附件库（路径化存储），再交给统一分流点
 * （计划门 / 编排判定 / 后端路由都在 lib/dispatch-intent，别在这里重写一遍）。
 * 落库失败会以内联数据降级，附件不会丢。
 */
async function dispatchWithAttachments(text: string, items: readonly Attachment[], pending: readonly MessageComment[]): Promise<void> {
  const threadId = sessionId.value || chat.activeThreadId;
  const ready = items.length ? await materializeAttachments(threadId, items) : [...items];
  await dispatchIntent(text, ready, { planGate: true, allowOrchestrate: true, comments: pending });
}

async function send(): Promise<void> {
  if (!canSend.value) return;
  const text = draft.value.trim();
  const items = attachmentItems.value.length ? takeAttachments() : [];
  const pending = comments.value;
  draft.value = "";
  comments.value = [];
  // 回合进行中不再禁发：入待发队列，回合结束后自动补发（Delta 式「待发草稿」）。
  // 附件同样先落库再入队 —— 否则补发时附件没有磁盘路径（与立即派发走同一条路）。
  // 评论随队列入队，补发时一并挂回消息。
  if (turnActive.value) {
    const threadId = sessionId.value || chat.activeThreadId;
    const ready = items.length ? await materializeAttachments(threadId, items) : items;
    chat.enqueueCommand(text, [...ready], pending);
  } else {
    void dispatchWithAttachments(text, items, pending);
  }
  scrollToBottom();
}

/** 移除一条待发选区评论（评论已追加进草稿的批注文本需用户自行删除）。 */
function removeComment(id: string): void {
  comments.value = comments.value.filter((comment) => comment.id !== id);
}

/** 把一条待发指令取回输入框编辑：出队 + 回填 + 聚焦。 */
function editPending(id: string): void {
  const item = chat.commandQueue.find((candidate) => candidate.id === id);
  if (!item) return;
  draft.value = item.input;
  chat.removeCommand(id);
  void nextTick(() => textareaEl.value?.focus());
}

function onKeydown(event: KeyboardEvent): void {
  // 斜杠菜单打开时先由它消费方向键 / Enter / Tab / Esc（含 IME 放行）。
  if (handleSlashKeydown(event)) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
}

function goBack(): void {
  void router.push("/guid");
}

/* ===== 空会话建议卡 =====
 * 新对话落地页只有标题 + 一行提示时，用户经常不知道从哪说起。给 4 条贴合本产品能力
 * （工作区 / 计划 / 审查 / 文档）的建议：点击只是把文本填进输入框（不发送），保留用户
 * 改写余地。文案走 i18n（chat.composer.suggest.*），图标是外壳形状表里的既有字形。 */
const SUGGESTIONS = [
  { key: "explore", icon: "search", label: "chat.composer.suggest.explore", text: "chat.composer.suggest.exploreText" },
  { key: "plan", icon: "calendar", label: "chat.composer.suggest.plan", text: "chat.composer.suggest.planText" },
  { key: "review", icon: "rotate-left", label: "chat.composer.suggest.review", text: "chat.composer.suggest.reviewText" },
  { key: "docs", icon: "file", label: "chat.composer.suggest.docs", text: "chat.composer.suggest.docsText" },
] as const;

function applySuggestion(suggestion: (typeof SUGGESTIONS)[number]): void {
  draft.value = t(suggestion.text);
  void nextTick(() => textareaEl.value?.focus());
}

/** 有可发送内容（文字 / 附件 / 选区评论）。回合进行中不再禁发 —— 发送会进待发队列。 */
const hasContent = computed(() => draft.value.trim().length > 0 || attachmentItems.value.length > 0 || comments.value.length > 0);
/** 发送按钮可用：与斜杠菜单共用「有没有内容」这一条（回合状态不再参与）。 */
const canSend = computed(() => hasContent.value);

/** 待发队列：全局队列按语义只属于「正在跑的会话」，别的会话不显示。 */
const pendingItems = computed(() => (chat.runningSessionId === sessionId.value ? chat.commandQueue : []));

/** 输入框占位：回合进行中提示会入队。 */
const composerPlaceholder = computed(() =>
  turnActive.value ? t("chat.composer.placeholderQueued") : t("chat.composer.placeholderThread"),
);

/** 权限档位胶囊文案（grey 外壳字面量，不走 i18n）。 */
const PERM_TIER_LABELS: Record<PermTier, string> = {
  "read-only": "只读",
  workspace: "工作区",
  full: "完全访问",
};
const permissionTierLabel = computed(() => PERM_TIER_LABELS[settings.permissionTier] ?? settings.permissionTier);
/** 窄屏「会话信息」下拉的触发器文案（同样走 grey 外壳字面量，不走 i18n）。 */
const PERM_SESSION_INFO_LABEL = "会话信息";

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

/** 可回退：只有带回合起点快照的用户消息（A3 在 sendGlobalTurn 起跑前写入 snapshotRef）。 */
function canRewind(message: ThreadMessage): boolean {
  return message.role === "user" && Boolean(message.snapshotRef);
}

/**
 * 执行回退：工作区硬恢复 + 截断消息流 + 清 ACP 绑定都在 `agent.rewindTo` 里。
 * 先关弹层再跑（与释放快照面板同套路）；失败文案走全局通知面，不在本视图另开一处错误位。
 */
async function performRewind(): Promise<void> {
  const target = rewindTarget.value;
  if (!target) return;
  rewindTarget.value = null;
  const error = await agent.rewindTo(sessionId.value || chat.activeThreadId, target.id);
  if (error) notice.error(error);
}

function buildMenu(target: ContextTarget | null): ContextMenuItem[] {
  if (target?.ctx === "message") {
    const id = target.el.dataset.messageId;
    const message = messages.value.find((candidate) => candidate.id === id);
    return buildMessageItems(message?.content ?? null, t, {
      copyBody: (text) => void copyText(text),
      ...(message && canRewind(message) ? { rewind: () => (rewindTarget.value = message) } : {}),
    });
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
          class="grid size-7 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
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
          <SubagentIndicator />
          <SessionStatusIndicator :status="status" chip />
          <!-- 三个状态胶囊在窄窗口会把标题挤没：≥1024px 直接铺开，更窄则收进「会话信息」下拉。 -->
          <div class="hidden items-center gap-1.5 lg:flex">
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
          </div>
          <!-- 窄屏入口：同一份信息换个落点，不再靠胶囊硬挤。只读信息，故用普通行而非菜单项。 -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                data-testid="session-info"
                class="flex h-5 cursor-pointer items-center gap-1 rounded-full border border-line bg-panel-2 px-2 text-[10.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan lg:hidden"
                :aria-label="PERM_SESSION_INFO_LABEL"
              >
                <Icon name="setting" :size="10" />
                {{ PERM_SESSION_INFO_LABEL }}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" class="w-[240px] border-line px-2 py-1.5">
              <div class="flex items-center justify-between gap-3 py-1">
                <span class="flex shrink-0 items-center gap-1 text-[11px] text-dim2"><Icon name="robot" :size="10" />运行后端</span>
                <span class="truncate text-[11.5px] text-foreground">{{ backendLabel }}</span>
              </div>
              <div class="flex items-center justify-between gap-3 py-1">
                <span class="flex shrink-0 items-center gap-1 text-[11px] text-dim2"><Icon name="shield" :size="10" />权限档位</span>
                <span class="truncate text-[11.5px] text-foreground">{{ permissionTierLabel }}</span>
              </div>
              <div v-if="agent.acpMcpServers.length || agent.acpMcpSkipped.length" class="flex items-start justify-between gap-3 py-1">
                <span class="flex shrink-0 items-center gap-1 pt-0.5 text-[11px] text-dim2"><Icon name="earth" :size="10" />MCP</span>
                <span class="truncate text-[11.5px]" :class="agent.acpMcpServers.length ? 'text-cyan' : 'text-dim2'" :title="mcpChipTitle">
                  {{ mcpChipLabel }}
                </span>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            v-if="turnActive"
            type="button"
            class="flex h-6 cursor-pointer items-center gap-1 rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
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
          <ConversationMessage
            v-for="message in messages"
            :key="message.id"
            :message="message"
            :thread-id="sessionId"
            @rewind="rewindTarget = $event"
          />
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
            <ConversationMessage :message="messages[row.index]" :thread-id="sessionId" @rewind="rewindTarget = $event" />
          </div>
        </div>
        <!-- 空会话引导：标题 + 建议卡（点击填入草稿，不直接发送）。 -->
        <div
          v-else
          class="mx-auto flex h-full w-full max-w-[860px] flex-col items-center justify-center gap-2 px-4 py-16 text-center sm:px-6"
        >
          <span class="grid size-10 place-items-center rounded-[calc(12px*var(--gw-radius-scale))] bg-panel-2 text-dim">
            <Icon name="message" :size="18" />
          </span>
          <p class="text-[13px] font-medium text-foreground">{{ t("chat.composer.emptyTitle") }}</p>
          <p class="text-[12px] text-dim2">{{ t("chat.composer.emptyHint") }}</p>
          <div class="mt-4 grid w-full max-w-[640px] grid-cols-1 gap-2 text-left sm:grid-cols-2">
            <button
              v-for="suggestion in SUGGESTIONS"
              :key="suggestion.key"
              type="button"
              data-testid="composer-suggestion"
              class="group/s flex cursor-pointer items-start gap-2 rounded-[calc(10px*var(--gw-radius-scale))] border border-line bg-panel px-3 py-2.5 transition-colors hover:border-line-2 hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              @click="applySuggestion(suggestion)"
            >
              <Icon
                :name="suggestion.icon"
                :size="13"
                class="mt-0.5 shrink-0 text-dim2 transition-colors group-hover/s:text-cyan"
              />
              <span class="min-w-0 flex-1">
                <span class="block text-[12px] font-medium text-foreground">{{ t(suggestion.label) }}</span>
                <span class="mt-0.5 block truncate text-[11px] text-dim2">{{ t(suggestion.text) }}</span>
              </span>
            </button>
          </div>
        </div>
      </div>

      <!-- 顶部一条极淡的上投影替代分隔线：让输入卡从消息流里"浮"起来，而不是靠硬线切开。 -->
      <div class="shrink-0 bg-panel px-4 py-3 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.18)] sm:px-6">
        <div class="mx-auto flex w-full max-w-[860px] flex-col gap-2.5">
          <!-- 选区评论草稿：挂在本条消息上的批注（展示被引用的原文片段），发送后渲染为注解。 -->
          <div v-if="comments.length" data-testid="comment-draft" class="flex flex-col gap-1.5">
            <div class="flex items-center gap-2 text-[10px] text-dim2">
              <span>{{ t("chat.comment.heading") }}</span>
              <span>{{ t("chat.comment.hint") }}</span>
            </div>
            <div
              v-for="comment in comments"
              :key="comment.id"
              data-testid="comment-draft-item"
              class="flex items-start gap-2 rounded-[calc(10px*var(--gw-radius-scale))] border border-line bg-panel px-3 py-2"
            >
              <Icon name="message" :size="12" class="mt-0.5 shrink-0 text-dim2" />
              <span class="min-w-0 flex-1 truncate text-[12px] text-dim" :title="comment.quote">{{ quoteSummary(comment.quote) }}</span>
              <button
                type="button"
                data-testid="comment-draft-remove"
                class="grid size-5 shrink-0 place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:text-destructive"
                :aria-label="t('chat.comment.remove')"
                @click="removeComment(comment.id)"
              >
                <Icon name="close" :size="12" />
              </button>
            </div>
          </div>
          <!-- 待发草稿：回合进行中发出的指令先落这里，回合结束自动补发。
               可「取回编辑」（出队回填输入框）或直接移除。 -->
          <div v-if="pendingItems.length" data-testid="pending-queue" class="flex flex-col gap-1.5">
            <div class="flex items-center gap-2 text-[10px] text-dim2">
              <span>{{ t("chat.queue.heading") }}</span>
              <span>{{ t("chat.queue.hint") }}</span>
            </div>
            <div
              v-for="item in pendingItems"
              :key="item.id"
              data-testid="pending-item"
              class="flex items-start gap-2 rounded-[calc(10px*var(--gw-radius-scale))] border border-dashed border-line-2 bg-panel px-3 py-2"
            >
              <span class="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground [overflow-wrap:anywhere]">{{
                item.input
              }}</span>
              <button
                type="button"
                data-testid="pending-edit"
                class="shrink-0 rounded-[calc(6px*var(--gw-radius-scale))] px-1.5 py-0.5 text-[11px] text-dim2 transition-colors hover:text-foreground"
                @click="editPending(item.id)"
              >
                {{ t("chat.queue.edit") }}
              </button>
              <button
                type="button"
                data-testid="pending-remove"
                class="grid size-5 shrink-0 place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:text-destructive"
                :aria-label="t('chat.queue.remove')"
                @click="chat.removeCommand(item.id)"
              >
                <Icon name="close" :size="12" />
              </button>
            </div>
          </div>
          <!-- 输入卡：管线仍归本页（send / 附件 / 斜杠 / 评论 / 待发队列），经 props + 具名
               slot 注入，与引导页共用同一个 MinimalComposer。 -->
          <MinimalComposer
            ref="composerRef"
            v-model="draft"
            :busy="turnActive"
            :can-send="canSend"
            :placeholder="composerPlaceholder"
            class="mx-auto"
            data-attachment-dropzone
            @submit="send"
            @attach="pickAttachmentFiles"
            @keydown="onKeydown"
            @paste="onComposerPaste"
            @blur="dismissSlashMenu"
            @dragover="onComposerDragOver"
            @dragleave="onComposerDragLeave"
            @drop="onComposerDrop"
          >
            <template #tray>
              <AttachmentTray :items="attachmentItems" @remove="removeAttachment" />
            </template>
            <template #menu>
              <SlashCommandMenu
                v-if="slashOpen"
                :items="slashItems"
                :active-index="slashActiveIndex"
                @select="selectSlashCommand"
                @update:active-index="slashActiveIndex = $event"
              />
            </template>
          </MinimalComposer>
        </div>
      </div>
    </section>

    <!-- 回退确认：工作区会硬恢复、消息流会截断，且 agent 上下文不可回退（必须明示）。 -->
    <ConfirmDialog
      v-if="rewindTarget"
      :title="t('chat.rewindConfirmTitle')"
      :message="t('chat.rewindConfirmBody')"
      :confirm-label="t('chat.rewindConfirmAction')"
      @confirm="performRewind"
      @cancel="rewindTarget = null"
    />
  </ContextMenuRegion>
</template>
