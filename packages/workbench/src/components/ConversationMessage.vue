<script setup lang="ts">
/**
 * 对话消息行：user 气泡 / assistant（按段有序渲染 + 等待占位）。
 *
 * 助手消息按 `message.segments` 的到达顺序渲染：思考 → 正文 → 工具 → 再思考 …
 * 每段思考各自折叠，工具批次就地展开细节。没有 segments 的消息（历史档 / 纯文本回复）
 * 退化为一段正文，不需要单独一套渲染路径。
 */
import { computed } from "vue";
import MarkdownText from "./MarkdownText.vue";
import ArtifactCards from "./ArtifactCards.vue";
import StreamText from "./chat/StreamText.vue";
import ThinkingBlock from "./chat/ThinkingBlock.vue";
import ToolTimeline from "./chat/ToolTimeline.vue";
import PlanCard from "./chat/PlanCard.vue";
import { useAgentStore } from "../stores/agent";
import { useChatStore } from "../stores/chat";
import type { MessageSegment, ThreadMessage, ToolActivity } from "../types";

const props = withDefaults(defineProps<{ message: ThreadMessage; threadId?: string }>(), { threadId: "" });

const agent = useAgentStore();
const chat = useChatStore();

const message = computed(() => props.message);

/** 流式中的消息走 StreamText 纯文本渲染，回合结束回落 Markdown（避免每 40ms 全量重解析）。 */
const isStreaming = computed(() => chat.streamingMessageId === message.value.id || agent.acpStreamId === message.value.id);

/** 回合活跃：LLM 流 / ACP 回合 / ACP 建会话。 */
const turnActive = computed(() => chat.busy || agent.acpBusy || agent.acpConnecting || agent.acpStatus === "connecting");

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
  <article class="flex flex-col">
    <div
      v-if="message.role === 'user'"
      class="msg__bubble ml-auto max-w-[78%] rounded-tl-[16px] rounded-tr-[16px] rounded-br-[4px] rounded-bl-[16px] bg-bubble px-4 py-3"
    >
      <p class="whitespace-pre-wrap text-[13.5px] leading-[1.7] text-foreground [overflow-wrap:anywhere]">{{ message.content }}</p>
    </div>
    <div v-else class="flex max-w-[92%] flex-col gap-2.5">
      <PlanCard v-if="message.planPending" :thread-id="threadId || chat.activeThreadId" :message="message" />
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
      <span class="text-[10px] text-dim2">{{ timeLabel(message.ts) }}</span>
    </div>
  </article>
</template>
