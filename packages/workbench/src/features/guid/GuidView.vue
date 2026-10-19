<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";
import AttachmentTray from "@/features/conversation/AttachmentTray.vue";
import SlashCommandMenu from "@/features/conversation/SlashCommandMenu.vue";
import MinimalComposer from "@/features/guid/MinimalComposer.vue";
import Icon from "@/features/shared/Icon.vue";
import ContextMenuRegion from "@/features/shared/ContextMenuRegion.vue";
import { buildComposerItems, type ComposerMenuActions, type ContextMenuItem, type ContextTarget } from "@/lib/context-menu";
import { copySelection, cutSelection, hasTextSelection, pasteInto, selectAllText } from "@/lib/textarea-actions";
import { useAttachments } from "@/lib/use-attachments";
import { useChatReceiver } from "@/lib/use-chat-receiver";
import { useTurnActive } from "@/lib/turn-activity";
import { dispatchIntent } from "@/lib/dispatch-intent";
import { useSlashCommands } from "@/lib/use-slash-commands";
import { materializeAttachments } from "@/state/attachment-library";
import { quoteSummary } from "@/lib/message-comments";
import type { Attachment, MessageComment } from "@/types";
/**
 * GreyWork 风格新对话引导页：hero + 快捷入口 + 输入卡（极简输入卡，与对话页共用同一份）。
 * 提交 → 新建会话 → 走 chat 管线（mock/真实 LLM）→ 跳到对话页。
 */
const router = useRouter();
const { t } = useI18n();
const agent = useAgentStore();
const chat = useChatStore();
const sessionStore = useSessionStore();
const workspaceStore = useWorkspaceStore();

const draft = ref("");
/** 选区评论草稿（预览划词 → 评论）：随首条消息挂上，发后清空。 */
const comments = ref<MessageComment[]>([]);

/** 图片可用性：本地 LLM 无能力声明（交给供应商报错），ACP 以 agent 声明为准。 */
const imagesAllowed = computed(() => !agent.routeToAcp || agent.acpImageSupport !== false);
/** 回合活跃：与对话页同源（此前这里只判了 busy/acpBusy 两个字段，建会话窗口漏掉了）。 */
const turnActive = useTurnActive();
const attachments = useAttachments(() => chat.activeThreadId, { imagesAllowed: () => imagesAllowed.value });
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

/** 斜杠命令菜单：发送复用 onSubmit（先建会话再派发），开关状态胶囊与对话页一致。
 *
 * textarea 元素归 `MinimalComposer` 所有，宿主经它的模板 ref 读暴露出来的元素：
 * 斜杠菜单回焦、右键菜单选区、划词注入桥都直接操作这颗 DOM。
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
    onSubmit();
  },
  canSend: () => !turnActive.value,
});

// 本视图能接收对话注入：注册接收方（预览划词工具条据此判断可用）+ 挂附件桥与预填桥。
// 网页正文「发送到对话」与划词工具条都走这条线，落到同一份附件草稿。
useChatReceiver({ draft, textarea: textareaEl, attachments, comments });

async function run(prompt: string, items: readonly Attachment[] = [], pending: readonly MessageComment[] = []): Promise<void> {
  const workspaceId = workspaceStore.activeWorkspaceId;
  const session = sessionStore.createSession(workspaceId);
  sessionStore.setActive(session.id);
  chat.activeThreadId = session.id;
  // 先跳转再落库：附件可能是几 MB 的图片，写盘不该把用户按在引导页上等。
  void router.push(`/conversation/${session.id}`);
  // 允许「只有附件 / 评论、没有文字」：图片与批注本身就是完整意图。
  if (prompt.trim() || items.length || pending.length) {
    // 附件落进新会话的附件库后再派发；落库失败会以内联降级，附件不会丢。
    // 分流（ACP / 编排 / 本地管线）在 lib/dispatch-intent，与对话页同一份。
    const ready = items.length ? await materializeAttachments(session.id, items) : [...items];
    await dispatchIntent(prompt, ready, { allowOrchestrate: true, comments: pending });
  }
}

function onSubmit(): void {
  if (!draft.value.trim() && attachmentItems.value.length === 0 && comments.value.length === 0) return;
  const items = attachmentItems.value.length ? takeAttachments() : [];
  const pending = comments.value;
  comments.value = [];
  void run(draft.value, items, pending);
  draft.value = "";
}

/** 移除一条待发选区评论。 */
function removeComment(id: string): void {
  comments.value = comments.value.filter((comment) => comment.id !== id);
}

function onKeydown(event: KeyboardEvent): void {
  // 斜杠菜单打开时先由它消费方向键 / Enter / Tab / Esc（含 IME 放行）。
  if (handleSlashKeydown(event)) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    onSubmit();
  }
}

/* ===== 输入框右键菜单 =====
 * 与对话页的输入框同一套条目（reka 的 trigger 会拦掉原生菜单，不补就一个编辑动作都没有）。
 * 区域挂在本页根 `<section>` 上：**不能**包输入卡那一层。这条约束最初的理由是 reka 的
 * asChild 会丢弃子元素的 ref（当时拖放命中判定依赖输入卡上的模板 ref `attachEl`）。
 * 如今判定走 `elementFromPoint().closest(DROPZONE_ATTR)`、不再依赖那个 ref —— 所以**也许**
 * 已经能放宽，但没实测过 asChild 会不会连 `data-attachment-dropzone` 一起吃掉，先维持原状。
 * 页头 / 空白处返回空表，抑制原生菜单（与对话页一致）。
 */
function composerActions(): ComposerMenuActions {
  const el = textareaEl.value;
  return {
    cut: () => void cutSelection(el),
    copy: () => void copySelection(el),
    paste: () => pasteInto(el),
    selectAll: () => selectAllText(el),
    hasSelection: hasTextSelection(el),
  };
}

function buildMenu(target: ContextTarget | null): ContextMenuItem[] {
  return target?.ctx === "composer" ? buildComposerItems(t, composerActions()) : [];
}
</script>

<template>
  <ContextMenuRegion :build="buildMenu">
    <section class="flex min-h-full w-full flex-col items-center justify-start px-4 pb-8 pt-16 sm:justify-center sm:py-8">
      <div class="flex w-full flex-col items-center gap-4 max-w-[760px]">
        <div class="flex w-full flex-col gap-2.5">
          <!-- 选区评论草稿：挂在本条消息上的批注（展示被引用的原文片段）。 -->
          <div v-if="comments.length" data-testid="comment-draft" class="flex flex-col gap-1.5">
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
          <!-- 输入卡：管线仍归本页（run / onSubmit / 附件 / 斜杠 / 评论），经 props + 具名
               slot 注入。拖放命中靠 data-attachment-dropzone 落到根元素（Vue 把属性与未声明
               的监听透传到单根），复用同一套 onComposerDrag* 处理器。 -->
          <MinimalComposer
            ref="composerRef"
            v-model="draft"
            :busy="turnActive"
            :can-send="!!draft.trim() || attachmentItems.length > 0"
            :placeholder="t('chat.composer.placeholderPitch')"
            data-attachment-dropzone
            @submit="onSubmit"
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
  </ContextMenuRegion>
</template>
