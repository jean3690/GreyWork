<script setup lang="ts">
/**
 * 对话消息行：user 气泡 / assistant（按段有序渲染 + 等待占位）。
 *
 * 助手消息按 `message.segments` 的到达顺序渲染：思考 → 正文 → 工具 → 再思考 …
 * 每段思考各自折叠，工具批次就地展开细节。没有 segments 的消息（历史档 / 纯文本回复）
 * 退化为一段正文，不需要单独一套渲染路径。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import MarkdownText from "@/features/shared/MarkdownText.vue";
import ArtifactCards from "@/features/activity/ArtifactCards.vue";
import StreamText from "@/features/conversation/StreamText.vue";
import ThinkingBlock from "@/features/conversation/ThinkingBlock.vue";
import ToolTimeline from "@/features/conversation/ToolTimeline.vue";
import PlanCard from "@/features/conversation/PlanCard.vue";
import AskQuestionCard from "@/features/conversation/AskQuestionCard.vue";
import ScheduleConfirmCard from "@/features/conversation/ScheduleConfirmCard.vue";
import PermissionCard from "@/features/conversation/PermissionCard.vue";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import { appEvents } from "@/events";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useAttachmentThumbs } from "@/lib/use-attachments";
import { useTurnActive } from "@/lib/turn-activity";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Attachment, MessageSegment, ThreadMessage, ToolActivity } from "@/types";

const props = withDefaults(defineProps<{ message: ThreadMessage; threadId?: string }>(), { threadId: "" });

const { t } = useI18n();
const agent = useAgentStore();
const chat = useChatStore();

const message = computed(() => props.message);

/** 附件缩略图（磁盘附件 → blob URL，模块级 LRU）；读不到时渲染占位。 */
const attachmentList = computed<readonly Attachment[]>(() => message.value.attachments ?? []);
const thumbs = useAttachmentThumbs(() => attachmentList.value);

/** 浏览器态没有磁盘通道：图片点击退化为组件内灯箱（桌面态走预览面板）。 */
/** 灯箱目标：dataUrl + 原始文件名（后者当弹层标题，让读屏知道在看哪张图）。 */
const lightbox = ref<{ src: string; name: string } | null>(null);

function openAttachment(item: Attachment): void {
  if (item.path) {
    // 跨面板「请求预览」语义，走事件而不是直调 preview store（桥接见 preview-bridge.ts）
    appEvents.emit("preview:request", { path: item.path, name: item.name, source: "disk" });
    return;
  }
  if (item.kind === "image" && item.dataUrl) lightbox.value = { src: item.dataUrl, name: item.name };
}

/** 附件是否点得开：有落库路径，或浏览器态的内联图片。都没有就别给可点的假象。 */
function canOpenAttachment(item: Attachment): boolean {
  return Boolean(item.path) || (item.kind === "image" && Boolean(item.dataUrl));
}

/** Dialog 收下 Esc / 点遮罩后关闭。 */
function onLightboxOpenChange(next: boolean): void {
  if (!next) lightbox.value = null;
}

/** 流式中的消息走 StreamText 纯文本渲染，回合结束回落 Markdown（避免每 40ms 全量重解析）。 */
const isStreaming = computed(() => chat.streamingMessageId === message.value.id || agent.acpStreamId === message.value.id);

/** 回合活跃：LLM 流 / ACP 回合 / ACP 建会话（判定收在 lib/turn-activity）。 */
const turnActive = useTurnActive();

/**
 * 渲染用段落表。没有 segments 却有正文的消息（内部 LLM 管线、历史档）补一段全量正文，
 * 让模板只有一条渲染路径。
 */
const segments = computed<MessageSegment[]>(() => {
  const list = message.value.segments;
  if (list && list.length > 0) return list;
  return message.value.content ? [{ kind: "text", id: `${message.value.id}-text`, from: 0, to: null }] : [];
});

const tailSegmentId = computed(() => segments.value.at(-1)?.id);

/** 等待首段产出（思考或正文都未开始）→ 助手侧显示「正在思考…」占位。 */
const awaitingOutput = computed(() => isStreaming.value && segments.value.length === 0 && turnActive.value);

/** text 段只记 content 偏移，取用时切片（正文不存两份）。 */
function textOf(segment: Extract<MessageSegment, { kind: "text" }>): string {
  return segment.to == null ? message.value.content.slice(segment.from) : message.value.content.slice(segment.from, segment.to);
}

function activitiesOf(segment: Extract<MessageSegment, { kind: "tools" }>): ToolActivity[] {
  return (message.value.tools ?? []).filter((activity) => segment.toolCallIds.includes(activity.toolCallId));
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
</script>

<template>
  <!-- data-ctx/data-message-id：会话页的右键菜单靠它认出「右键的是哪条消息」（见 ConversationView）。 -->
  <article class="flex flex-col" data-ctx="message" :data-message-id="message.id">
    <div
      v-if="message.role === 'user'"
      class="msg__bubble ml-auto max-w-[78%] rounded-tl-[16px] rounded-tr-[16px] rounded-br-[4px] rounded-bl-[16px] bg-bubble px-4 py-3"
    >
      <div class="flex flex-col gap-2">
        <div v-if="attachmentList.length" data-testid="message-attachments" class="flex flex-wrap items-center gap-2">
          <template v-for="item in attachmentList" :key="item.id">
            <!-- 视频 / 语音：内联播放器（自身可交互，不套「点开预览」按钮）。读不到源时落到下面的文件 chip。 -->
            <video
              v-if="item.kind === 'video' && thumbs[item.id]"
              :src="thumbs[item.id] as string"
              :aria-label="item.name"
              data-testid="message-attachment-video"
              class="max-h-[240px] max-w-[280px] rounded-[8px] border border-line-2 bg-black"
              controls
              playsinline
              preload="metadata"
            />
            <audio
              v-else-if="item.kind === 'audio' && thumbs[item.id]"
              :src="thumbs[item.id] as string"
              :aria-label="item.name"
              data-testid="message-attachment-audio"
              class="w-[240px]"
              controls
              preload="metadata"
            />
            <Hint v-else :text="item.name" multiline>
              <button
                type="button"
                class="cursor-pointer overflow-hidden rounded-[8px] border border-line-2 text-left transition-opacity hover:opacity-90 disabled:cursor-default disabled:hover:opacity-100"
                :aria-label="item.name"
                :disabled="!canOpenAttachment(item)"
                :data-testid="item.kind === 'image' ? 'message-attachment-image' : 'message-attachment-file'"
                @click="openAttachment(item)"
              >
                <img
                  v-if="item.kind === 'image' && thumbs[item.id]"
                  :src="thumbs[item.id] as string"
                  :alt="item.name"
                  class="max-h-[180px] max-w-[240px] object-cover"
                />
                <span
                  v-else-if="item.kind === 'image'"
                  class="grid h-[72px] w-[96px] place-items-center bg-panel-2 px-2 text-center text-[10px] leading-tight text-dim2"
                >
                  {{ t("chat.attachUnavailable") }}
                </span>
                <span v-else class="flex max-w-[220px] items-center gap-1.5 bg-panel px-2 py-1.5">
                  <Icon name="file" :size="12" class="shrink-0 text-dim" />
                  <span class="truncate text-[11.5px] text-foreground">{{ item.name }}</span>
                </span>
              </button>
            </Hint>
          </template>
        </div>
        <p v-if="message.content" class="whitespace-pre-wrap text-[13.5px] leading-[1.7] text-foreground [overflow-wrap:anywhere]">
          {{ message.content }}
        </p>
      </div>
    </div>
    <div v-else class="flex max-w-[92%] flex-col gap-2.5">
      <PlanCard v-if="message.planPending" :thread-id="threadId || chat.activeThreadId" :message="message" />
      <AskQuestionCard v-if="message.ask" :thread-id="threadId || chat.activeThreadId" :message="message" />
      <ScheduleConfirmCard v-if="message.scheduleDraft" :thread-id="threadId || chat.activeThreadId" :message="message" />
      <div
        v-if="awaitingOutput"
        class="flex h-9 items-center gap-2.5 rounded-[12px] border border-line bg-panel-2 px-3.5 text-[12px] text-dim"
      >
        <span class="flex items-center gap-1">
          <span class="size-1.5 animate-bounce rounded-full bg-cyan/70 [animation-delay:0ms]" />
          <span class="size-1.5 animate-bounce rounded-full bg-cyan/70 [animation-delay:150ms]" />
          <span class="size-1.5 animate-bounce rounded-full bg-cyan/70 [animation-delay:300ms]" />
        </span>
        {{ isStreaming && agent.acpStreamId === message.id ? "正在思考…" : "正在生成…" }}
      </div>
      <template v-for="segment in segments" :key="segment.id">
        <ThinkingBlock
          v-if="segment.kind === 'thinking'"
          :segment="segment"
          :live="isStreaming && turnActive && segment.id === tailSegmentId"
        />
        <ToolTimeline v-else-if="segment.kind === 'tools'" :activities="activitiesOf(segment)" />
        <StreamText v-else-if="isStreaming && segment.id === tailSegmentId" :content="textOf(segment)" />
        <MarkdownText v-else :content="textOf(segment)" />
      </template>
      <ArtifactCards v-if="message.artifacts?.length" :ids="message.artifacts" />
      <!-- 权限裁决留痕：活跃卡片在输入框上方（那里才是「等你点」的位置），
           裁决后卡片消失，但记录留在消息流里，回看能知道当时批了什么。 -->
      <PermissionCard v-for="trace in message.permissions ?? []" :key="trace.toolCallId" :trace="trace" />
      <span class="text-[10px] text-dim2">{{ timeLabel(message.ts) }}</span>
    </div>
  </article>
  <!-- 浏览器态图片附件没有磁盘通道可开预览面板，用组件内灯箱兜底。
       走 Dialog 而非手写 Teleport：退场动画、焦点陷阱、滚动锁、以及最要紧的 Esc 关闭
       都是现成的（旧实现只有「点一下关」）。 -->
  <Dialog :open="lightbox !== null" @update:open="onLightboxOpenChange">
    <DialogContent
      :show-close-button="false"
      data-testid="attachment-lightbox"
      class="w-auto max-w-[90vw] cursor-zoom-out gap-0 border-0 bg-transparent p-0 shadow-none"
      @click="lightbox = null"
    >
      <DialogTitle class="sr-only">{{ lightbox?.name }}</DialogTitle>
      <DialogDescription class="sr-only">{{ t("chat.imagePreviewClose") }}</DialogDescription>
      <img :src="lightbox?.src" alt="" class="max-h-[85vh] max-w-full rounded-[10px] object-contain" />
    </DialogContent>
  </Dialog>
</template>
