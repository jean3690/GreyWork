<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useAgentStore } from "../stores/agent";
import { useRunsStore } from "../stores/runs";
import { useChatStore } from "../stores/chat";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { useWorkspaceStore } from "../stores/workspace";
import AcpSessionConfig from "../components/AcpSessionConfig.vue";
import AgentProviderBar from "../components/AgentProviderBar.vue";
import AttachmentTray from "../components/chat/AttachmentTray.vue";
import SlashCommandMenu from "../components/chat/SlashCommandMenu.vue";
import Icon from "../components/Icon.vue";
import { useAttachments } from "../lib/use-attachments";
import { useSlashCommands } from "../lib/use-slash-commands";
import { materializeAttachments } from "../state/attachment-library";
import type { Attachment } from "../types";
import logoUrl from "../assets/logo.svg?url";

/**
 * GreyWork 风格新对话引导页：hero + 快捷入口 + 输入卡。
 * 提交 → 新建会话 → 走 chat 管线（mock/真实 LLM）→ 跳到对话页。
 */
const router = useRouter();
const { t } = useI18n();
const agent = useAgentStore();
const runs = useRunsStore();
const chat = useChatStore();
const sessionStore = useSessionStore();
const workspaceStore = useWorkspaceStore();
const settings = useSettingsStore();

const draft = ref("");

/** 图片可用性：本地 LLM 无能力声明（交给供应商报错），ACP 以 agent 声明为准。 */
const imagesAllowed = computed(() => !agent.routeToAcp || agent.acpImageSupport !== false);
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
} = useAttachments(() => chat.activeThreadId, { imagesAllowed: () => imagesAllowed.value });

/** 斜杠命令菜单：发送复用 onSubmit（先建会话再派发），开关状态胶囊与对话页一致。 */
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
    onSubmit();
  },
  canSend: () => !agent.acpBusy && !chat.busy,
});

async function run(prompt: string, items: readonly Attachment[] = []): Promise<void> {
  const workspaceId = workspaceStore.activeWorkspaceId;
  const session = sessionStore.createSession(workspaceId);
  sessionStore.setActive(session.id);
  chat.activeThreadId = session.id;
  // 先跳转再落库：附件可能是几 MB 的图片，写盘不该把用户按在引导页上等。
  void router.push(`/conversation/${session.id}`);
  // 允许「只有附件、没有文字」：图片本身就是完整意图（截图问答的常态）。
  if (prompt.trim() || items.length) {
    // 附件落进新会话的附件库后再派发；落库失败会以内联降级，附件不会丢。
    const ready = items.length ? await materializeAttachments(session.id, items) : [...items];
    if (agent.routeToAcp) {
      // ACP agent 选中：回合由宿主事件驱动（chunk/权限/停止），不进 LLM 管线。
      await agent.dispatchToAcp(prompt, ready);
    } else if (ready.length === 0 && runs.maybeOrchestrate(prompt)) {
      // 编排意图（「自动执行/编排 …」）：planner 拆解 → 并行子任务，TeamView 看板跟踪。
      // 带附件时跳过：planner 只做纯文本拆解，附件无法随子任务传递。
    } else {
      chat.submitText(prompt, ready);
    }
  }
}

function onSubmit(): void {
  if (!draft.value.trim() && attachmentItems.value.length === 0) return;
  const items = attachmentItems.value.length ? takeAttachments() : [];
  void run(draft.value, items);
  draft.value = "";
}

function onKeydown(event: KeyboardEvent): void {
  // 斜杠菜单打开时先由它消费方向键 / Enter / Tab / Esc（含 IME 放行）。
  if (handleSlashKeydown(event)) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    onSubmit();
  }
}
</script>

<template>
  <section class="flex min-h-full w-full flex-col items-center justify-start px-4 pb-8 pt-16 sm:justify-center sm:py-8">
    <div class="flex w-full max-w-[800px] flex-col items-center gap-4 sm:-translate-y-[5vh]">
      <div class="flex flex-col items-center gap-3 text-center">
        <span class="grid size-12 place-items-center rounded-[14px] border border-line-2 bg-console shadow-[0_8px_28px_rgba(0,0,0,0.18)]">
          <img :src="logoUrl" alt="" class="size-7 shrink-0 rounded-[8px]" width="28" height="28" />
        </span>
      </div>

      <div class="flex w-full flex-col gap-2.5">
        <AgentProviderBar />
        <div
          ref="attachEl"
          data-attachment-dropzone
          data-testid="composer-card"
          class="relative flex w-full flex-col gap-2 rounded-[16px] border bg-panel-2 p-3 shadow-[0_10px_32px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow] focus-within:border-cyan/50 focus-within:shadow-[0_12px_36px_rgba(0,0,0,0.16)]"
          :class="attachmentDragging ? 'border-cyan ring-2 ring-cyan/40' : 'border-line-2'"
          @dragover="onComposerDragOver"
          @dragleave="onComposerDragLeave"
          @drop="onComposerDrop"
        >
          <AttachmentTray :items="attachmentItems" @remove="removeAttachment" />
          <textarea
            ref="textareaEl"
            v-model="draft"
            rows="3"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="slashOpen"
            :aria-controls="slashOpen ? 'slash-command-menu' : undefined"
            :aria-activedescendant="slashActiveOptionId"
            class="min-h-[88px] w-full resize-none bg-transparent px-2 py-1 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-dim"
            placeholder="描述你想完成的任务，回车发送…"
            :aria-label="'发送消息'"
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
              <button
                type="button"
                data-testid="composer-attach"
                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="attachmentsFull"
                :aria-label="t('chat.uploadFile')"
                :title="imagesAllowed ? t('chat.uploadFile') : t('chat.attachImagesUnsupported')"
                @click="pickAttachmentFiles"
              >
                <Icon name="plus" :size="14" />
              </button>
              <span class="text-[11px] text-dim2">
                运行环境：{{ settings.runMode === "cloud" ? "云端" : settings.runMode === "worktree" ? "独立工作树" : "本地" }}
              </span>
              <button
                v-if="settings.planMode"
                type="button"
                data-testid="composer-plan-chip"
                class="flex h-5 shrink-0 cursor-pointer items-center rounded-full border border-line bg-panel px-2 text-[10.5px] text-dim transition-colors hover:text-foreground"
                :title="t('chat.planModeTitle')"
                @click="settings.planMode = false"
              >
                {{ t("chat.planMode") }}
              </button>
              <button
                v-if="chat.speedBoost"
                type="button"
                data-testid="composer-speed-chip"
                class="flex h-5 shrink-0 cursor-pointer items-center rounded-full border border-line bg-panel px-2 text-[10.5px] text-dim transition-colors hover:text-foreground"
                :title="t('chat.speedTitle')"
                @click="chat.speedBoost = false"
              >
                {{ t("chat.speedBoost") }}
              </button>
            </div>
            <button
              data-testid="composer-send"
              class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] border border-accent bg-accent px-3 text-[12px] font-medium text-accent-ink transition-[background-color,border-color,color,opacity] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:border-line-2 disabled:bg-panel disabled:text-dim2 disabled:opacity-100"
              :disabled="!draft.trim() && attachmentItems.length === 0"
              @click="onSubmit"
            >
              发送
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
</template>
