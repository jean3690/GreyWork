<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import Icon from "@/features/shared/Icon.vue";
import MarkdownText from "@/features/shared/MarkdownText.vue";
import ContextMenuRegion from "@/features/shared/ContextMenuRegion.vue";
import { buildComposerItems, type ComposerMenuActions, type ContextMenuItem, type ContextTarget } from "@/lib/context-menu";
import { copySelection, cutSelection, hasTextSelection, pasteInto, selectAllText } from "@/lib/textarea-actions";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";
import { useSessionStore } from "@/stores/session";

/**
 * 微信会话页：一个联系人一段对话，两边都能看到。
 *
 * 取向与对话页相反 —— 这里是「微信里看到的样子」：对端（手机那侧）在左，本机发出的
 * 助手回复与人工回复在右。所以本页按消息角色自己排气泡，而不是复用对话页的消息组件。
 *
 * 这里只呈现微信里也能看到的内容（文字）；agent 的工具调用 / 推理过程属于本机执行细节，
 * 不在这条通道的语义里。发送走宿主的 sendmessage 命令，必须带上对端最近一次入站的
 * context_token（协议要求），没有就等于对方还没来过消息，只能等对方先开口。
 */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const store = useRemoteAssistantStore();
const sessionStore = useSessionStore();

/** 路由参数是联系人主键：`<通道>:<对端 id>`（通道内唯一，跨通道不撞）。 */
const peerId = computed(() => decodeURIComponent(String(route.params.peerId ?? "")));
const peer = computed(() => store.peerById(peerId.value));
const messages = computed(() => {
  const record = peer.value ? sessionStore.getSession(peer.value.sessionId) : undefined;
  return record?.messages ?? [];
});

const draft = ref("");
const sending = ref(false);
const sendError = ref<string | null>(null);
const scroller = ref<HTMLElement | null>(null);

/** 能发的前提：通道在收消息；微信还要求这个联系人给过我们 context_token。 */
const canSend = computed(() => {
  if (!peer.value || !store.connectedOf(peer.value.channel)) return false;
  return peer.value.channel !== "wechat" || Boolean(peer.value.contextToken);
});
const blockedHint = computed(() => {
  if (!peer.value) return t("remoteAssist.conversation.unknownPeer");
  if (!store.connectedOf(peer.value.channel)) return t("remoteAssist.conversation.offlineHint");
  if (peer.value.channel === "wechat" && !peer.value.contextToken) return t("remoteAssist.conversation.noContextToken");
  return "";
});

function scrollToBottom(): void {
  void nextTick(() => {
    const element = scroller.value;
    if (element) element.scrollTop = element.scrollHeight;
  });
}

onMounted(() => {
  store.markPeerRead(peerId.value);
  scrollToBottom();
});

// 新消息到达即读掉未读并跟到底部（正在看这页时不需要未读提示）。
watch(
  () => messages.value.length,
  () => {
    store.markPeerRead(peerId.value);
    scrollToBottom();
  },
);

async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value || !canSend.value) return;
  sending.value = true;
  sendError.value = null;
  const result = await store.sendFromDesktop(peerId.value, text);
  sending.value = false;
  if (result.ok) draft.value = "";
  else sendError.value = result.error ?? "";
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  void send();
}

function back(): void {
  void router.push("/assistants");
}

/* ===== 输入框右键菜单 =====
 * 与对话页 / 新建对话页的输入框同一套条目。区域挂在本页根 `<section>`：textarea 自己
 * 带 ref，不能当 trigger（reka 的 asChild 会丢弃子元素的 ref）。
 */
const composerEl = ref<HTMLTextAreaElement | null>(null);

function composerActions(): ComposerMenuActions {
  const el = composerEl.value;
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
    <section class="mx-auto flex min-h-0 h-full w-full max-w-[860px] flex-col px-4 py-4 sm:px-6" data-testid="remote-conversation">
      <header class="mb-3 flex items-center gap-2.5">
        <!-- title 与 aria-label 同文案：可读名已由 aria-label 给出，重复的悬停提示没有增量 -->
        <button
          type="button"
          class="grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] border border-line bg-panel-2 text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-label="t('remoteAssist.conversation.back')"
          data-testid="remote-conversation-back"
          @click="back"
        >
          <Icon name="arrow-left" :size="14" />
        </button>
        <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-panel-2 text-dim">
          <Icon name="message" :size="16" />
        </span>
        <div class="min-w-0">
          <div class="truncate text-[13px] font-medium text-foreground">
            <template v-if="peer">{{ t(`remoteAssist.channels.${peer.channel}`) }} · {{ peer.nick }}</template>
            <template v-else>{{ peerId }}</template>
          </div>
          <div class="truncate text-[11px] text-dim2">
            {{ peer && store.connectedOf(peer.channel) ? t("remoteAssist.channels.online") : t("remoteAssist.channels.offline") }}
          </div>
        </div>
      </header>

      <div
        ref="scroller"
        class="min-h-0 flex-1 overflow-y-auto rounded-[14px] border border-line bg-panel p-3"
        data-testid="remote-message-list"
      >
        <p v-if="messages.length === 0" class="py-10 text-center text-[12px] text-dim2">{{ t("remoteAssist.conversation.empty") }}</p>
        <ul v-else class="flex flex-col gap-2.5">
          <li v-for="message in messages" :key="message.id" class="flex" :class="message.role === 'user' ? 'justify-start' : 'justify-end'">
            <!-- 对端（微信那侧）：左侧浅底；本机助手 / 人工回复：右侧主色底 -->
            <div
              class="max-w-[78%] rounded-[12px] px-3 py-2 text-[12.5px] leading-relaxed"
              :class="message.role === 'user' ? 'bg-panel-2 text-foreground' : 'bg-accent/12 text-foreground'"
              :data-role="message.role"
            >
              <MarkdownText :content="message.content" />
            </div>
          </li>
        </ul>
      </div>

      <footer class="mt-3">
        <div class="flex flex-col gap-2 rounded-[14px] border border-line-2 bg-panel-2 p-2.5">
          <textarea
            ref="composerEl"
            v-model="draft"
            data-ctx="composer"
            rows="2"
            class="min-h-[52px] w-full resize-none bg-transparent px-2 py-1 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-dim"
            :placeholder="t('remoteAssist.conversation.placeholder')"
            :aria-label="t('remoteAssist.conversation.send')"
            data-testid="remote-composer-input"
            @keydown="onKeydown"
          />
          <div class="flex items-center justify-between gap-2">
            <span class="min-w-0 truncate text-[11px] text-dim2" data-testid="remote-composer-hint">
              {{ canSend ? "" : blockedHint }}
            </span>
            <button
              type="button"
              class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] border border-accent bg-accent px-3 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:border-line-2 disabled:bg-panel disabled:text-dim2 disabled:opacity-100"
              :disabled="!canSend || !draft.trim() || sending"
              data-testid="remote-composer-send"
              @click="void send()"
            >
              {{ sending ? t("remoteAssist.conversation.sending") : t("remoteAssist.conversation.send") }}
              <Icon name="send-one" :size="13" />
            </button>
          </div>
          <p v-if="sendError" class="text-[11px] text-destructive" data-testid="remote-composer-error">{{ sendError }}</p>
        </div>
      </footer>
    </section>
  </ContextMenuRegion>
</template>
