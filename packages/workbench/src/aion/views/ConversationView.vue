<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import MarkdownText from "../../components/MarkdownText.vue";
import StreamText from "../../components/chat/StreamText.vue";
import ThinkingBlock from "../../components/chat/ThinkingBlock.vue";
import { useAgentStore } from "../../stores/agent";
import { useChatStore } from "../../stores/chat";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useWorkspaceStore } from "../../stores/workspace";
import type { ThreadMessage } from "../../types";
import AcpModelSelector from "../components/AcpModelSelector.vue";
import AgentProviderBar from "../components/AgentProviderBar.vue";
import AionIcon from "../components/AionIcon.vue";

/**
 * AionUi 风格对话页：消息流 + 底部输入卡。
 * 路由参数 conversationId → 会话（缺省空建）→ chat.activeThreadId。
 */
const route = useRoute();
const router = useRouter();
const agent = useAgentStore();
const chat = useChatStore();
const sessionStore = useSessionStore();
const settings = useSettingsStore();
const workspaceStore = useWorkspaceStore();

const draft = ref("");
const scrollEl = ref<HTMLElement | null>(null);

const sessionId = computed(() => {
  const raw = route.params.conversationId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return id ?? "";
});

const session = computed(() => (sessionId.value ? sessionStore.getSession(sessionId.value) : undefined));
const messages = computed<ThreadMessage[]>(() => (sessionId.value ? sessionStore.ensure(sessionId.value) : []));

/** 当前运行后端展示名：ACP agent（routeToAcp 开启时）或 Local LLM。 */
const backendLabel = computed(() => {
  if (!agent.routeToAcp) return "Local";
  const provider = agent.agentProviders.find((candidate) => candidate.id === agent.selectedProviderId);
  return provider?.name ?? "ACP";
});
/** 运行中：chat LLM 流或 ACP 回合任一活跃。 */
const busy = computed(() => chat.busy || agent.acpBusy);

function stop(): void {
  if (agent.acpBusy) void agent.stopAcp();
  else chat.abortGeneration();
}

const workspaceName = computed(() => {
  const workspace = workspaceStore.workspaces.find((workspace) => workspace.id === session.value?.workspaceId);
  return workspace?.name ?? "普通对话";
});

function syncActive(): void {
  if (!sessionId.value) {
    const created = sessionStore.createSession(workspaceStore.activeWorkspaceId);
    void router.replace(`/conversation/${created.id}`);
    return;
  }
  sessionStore.setActive(sessionId.value);
  chat.activeThreadId = sessionId.value;
}
watch(sessionId, syncActive, { immediate: true });

function scrollToBottom(): void {
  void nextTick(() => scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight }));
}
watch(() => messages.value.map((message) => message.content.length).join(","), scrollToBottom);

/** 流式中的消息走 StreamText 纯文本渲染，回合结束回落 Markdown（避免每 40ms 全量重解析）。
 *  ACP 回合的支架由 agent.acpStreamId 标记（chat.streamingMessageId 只覆盖本地 LLM 管线）。 */
function isStreaming(message: ThreadMessage): boolean {
  return chat.streamingMessageId === message.id || agent.acpStreamId === message.id;
}

/** 模型之外的 select 型配置项（思考强度 / 模式等）。键名因 agent 而异，
 *  统一渲染而不是写死 id 去猜，避免后端换了名字就整块消失。 */
const extraOptionIds = computed(() =>
  agent.acpConfigOptions.filter((entry) => entry.type === "select" && entry.id !== "model").map((entry) => entry.id),
);

function send(): void {
  const text = draft.value.trim();
  if (!text || chat.busy || agent.acpBusy) return;
  if (agent.routeToAcp) {
    void agent.dispatchToAcp(text);
  } else if (agent.maybeOrchestrate(text)) {
    // 编排意图：并行子任务在 TeamView 看板跟踪（goal 不入本会话消息流）。
  } else {
    chat.submitText(text);
  }
  draft.value = "";
  scrollToBottom();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

function goBack(): void {
  void router.push("/guid");
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
</script>

<template>
  <section class="flex min-h-0 flex-col">
    <div class="flex h-[46px] shrink-0 items-center gap-2 border-b border-line-2 bg-panel px-3">
      <button
        class="grid size-7 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        aria-label="返回"
        @click="goBack"
      >
        <AionIcon name="arrow-left" :size="16" />
      </button>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[13px] font-medium text-foreground">{{ session?.title ?? "新对话" }}</div>
        <div class="truncate text-[10px] text-dim2">{{ workspaceName }}</div>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <template v-if="agent.routeToAcp">
          <AcpModelSelector option-id="model" placeholder="Use CLI model" icon="magic" />
          <AcpModelSelector v-for="id in extraOptionIds" :key="id" :option-id="id" icon="setting" show-name />
          <button
            v-if="agent.acpConnected"
            type="button"
            title="重启 ACP runtime（重新探测模型与配置）"
            class="grid size-6 cursor-pointer place-items-center rounded-full border border-line bg-panel-2 text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :disabled="agent.acpBusy"
            @click="agent.restartAcpRuntime()"
          >
            <AionIcon name="refresh" :size="12" />
          </button>
        </template>
        <span class="flex h-5 items-center gap-1 rounded-full border border-line bg-panel-2 px-2 text-[10.5px] text-dim">
          <AionIcon name="robot" :size="10" />
          {{ backendLabel }}
        </span>
        <span class="flex h-5 items-center gap-1 rounded-full border border-line bg-panel-2 px-2 text-[10.5px] text-dim">
          <AionIcon name="shield" :size="10" />
          {{ settings.permissionTier }}
        </span>
        <button
          v-if="busy"
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          @click="stop"
        >
          <AionIcon name="close-one" :size="11" />
          停止
        </button>
      </div>
    </div>

    <div ref="scrollEl" class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-6 py-6">
        <template v-if="messages.length">
          <article v-for="message in messages" :key="message.id" class="flex flex-col">
            <div
              v-if="message.role === 'user'"
              class="msg__bubble ml-auto max-w-[78%] rounded-tl-[16px] rounded-tr-[16px] rounded-br-[4px] rounded-bl-[16px] bg-bubble px-4 py-3"
            >
              <p class="whitespace-pre-wrap text-[13.5px] leading-[1.7] text-foreground [overflow-wrap:anywhere]">{{ message.content }}</p>
            </div>
            <div v-else class="flex max-w-[92%] flex-col gap-2.5">
              <ThinkingBlock v-if="message.thinking && chat.thinkingMessageId !== message.id" :message="message" />
              <MarkdownText v-if="message.content && !isStreaming(message)" :content="message.content" />
              <StreamText v-else-if="isStreaming(message)" :content="message.content" />
              <span class="text-[10px] text-dim2">{{ timeLabel(message.ts) }}</span>
            </div>
          </article>
        </template>
        <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <span class="grid size-10 place-items-center rounded-[12px] bg-panel-2 text-dim">
            <AionIcon name="message" :size="18" />
          </span>
          <p class="text-[13px] font-medium text-foreground">新对话已就绪</p>
          <p class="text-[12px] text-dim2">输入指令开始工作，回车发送。</p>
        </div>
      </div>
    </div>

    <div class="shrink-0 border-t border-line-2 bg-panel px-6 py-3">
      <div class="mx-auto flex w-full max-w-[860px] flex-col gap-2">
        <AgentProviderBar />
        <div class="flex w-full flex-col gap-2 rounded-[16px] border border-line bg-panel-2 p-2.5">
          <textarea
            v-model="draft"
            rows="3"
            class="w-full resize-none bg-transparent px-2 py-1 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-dim2"
            placeholder="输入指令，Enter 发送，Shift+Enter 换行…"
            :aria-label="'发送消息'"
            @keydown="onKeydown"
          />
          <div class="flex items-center justify-between gap-2">
            <span class="pl-2 text-[11px] text-dim2">
              {{ chat.busy || agent.acpBusy ? "处理中…" : "就绪" }}
            </span>
            <button
              class="flex h-8 cursor-pointer items-center gap-1.5 rounded-[10px] bg-console px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!draft.trim() || chat.busy || agent.acpBusy"
              @click="send"
            >
              发送
              <AionIcon name="send-one" :size="13" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
